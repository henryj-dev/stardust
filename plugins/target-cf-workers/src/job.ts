/**
 * The Job that releases a Cloudflare Worker from one commit. Three steps in
 * one pod, so the token never meets the repository's own code:
 *
 *   clone   (init)  the commit, with the clone token if there is one
 *   build   (init)  install with the lockfile's package manager and run the
 *                   `build` script; no credentials of any kind
 *   deploy          a Wrangler stardust pins, with the operator's
 *                   wrangler.jsonc: D1 migrations, `secret bulk`, `deploy`;
 *                   the Cloudflare token lives here only
 *
 * The Worker's configuration and secrets are the operator's, kept in the
 * deploy repository and applied to the builds namespace: a ConfigMap and an
 * optional Secret named `wrangler-<project>-<component>` (keys
 * `wrangler.jsonc` and `secrets.json`). A repository's own `.env` files and
 * Wrangler configs are not read when deploying.
 */
import type { DeployRequest } from "@stardust/core";

export const DEFAULT_IMAGES = {
  git: "alpine/git:v2.54.0@sha256:e8ceedc73bd80992ae8d58a7d24c58b8322146c354f1d2e81a97db4452068ec0",
  node: "node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d",
} as const;
export const DEFAULT_WRANGLER = "4.156.0";

export interface WorkersOptions {
  namespace: string;
  /** Secret with the Cloudflare API token and account id (keys `token` and `account-id`). */
  tokenSecret: string;
  /** Secret with key `token` that can read private repositories. */
  cloneSecret?: string;
  gitBaseUrl?: string;
  cloneUsername?: string;
  wranglerVersion?: string;
  images?: { git: string; node: string };
  deadlineSeconds?: number;
  ttlSeconds?: number;
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const RELATIVE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]+$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export class DeployInputError extends Error {}

/** The ConfigMap and Secret the operator keeps for a component. */
export const configName = (project: string, component: string) =>
  `wrangler-${project.toLowerCase()}-${component.toLowerCase()}`.slice(0, 63).replace(/-+$/, "");

export function validateDeploy(req: DeployRequest, options: WorkersOptions): void {
  if (!REPO.test(req.repo)) throw new DeployInputError(`not a repository: ${req.repo}`);
  if (!SHA.test(req.sha)) throw new DeployInputError("sha must be a full commit SHA");
  if (!NAME.test(configName(req.projectId, req.component)))
    throw new DeployInputError("project and component must be names");
  if (req.context !== undefined && !RELATIVE.test(req.context))
    throw new DeployInputError("context must be a relative path");
  for (const key of Object.keys(req.buildEnv ?? {})) {
    if (!ENV_KEY.test(key)) throw new DeployInputError(`not an env name: ${key}`);
  }
  if (options.wranglerVersion !== undefined && !VERSION.test(options.wranglerVersion)) {
    throw new DeployInputError("wranglerVersion must be an exact version");
  }
}

const CLONE = `set -eu
mkdir -p "\${HOME}"
git init -q /workspace/src
cd /workspace/src
if [ -n "\${GITHUB_TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="http.\${GIT_BASE}/.extraheader"
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf '%s:%s' "\${GIT_USERNAME}" "\${GITHUB_TOKEN}" | base64 | tr -d '\\n')"
  export GIT_CONFIG_VALUE_0
fi
git fetch -q --depth 1 "\${GIT_BASE}/\${REPO}.git" "\${SHA}"
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GITHUB_TOKEN
git checkout -q --detach FETCH_HEAD
echo "[clone] \${REPO} @ \${SHA}"
`;

/** No credentials here: this runs the repository's own install and build scripts. */
export const BUILD = `set -eu
export PATH="/workspace/bin:\${PATH}"
mkdir -p /workspace/bin "\${HOME}"
cd "/workspace/src/\${CONTEXT}"
if [ -f pnpm-lock.yaml ]; then
  corepack enable --install-directory /workspace/bin pnpm
  pnpm install --frozen-lockfile; PM=pnpm
elif [ -f yarn.lock ]; then
  corepack enable --install-directory /workspace/bin yarn
  yarn install --frozen-lockfile; PM=yarn
elif [ -f package-lock.json ]; then
  npm ci; PM=npm
elif [ -f bun.lock ] || [ -f bun.lockb ]; then
  echo "[build] bun lockfiles are not supported: commit a package-lock.json, pnpm-lock.yaml or yarn.lock" >&2; exit 1
else
  echo "[build] no lockfile: installs must be reproducible" >&2; exit 1
fi
if node -e 'process.exit(require("./package.json").scripts?.build ? 0 : 1)'; then "\${PM}" run build; fi
echo "[build] done"
`;

/** Lists the D1 bindings whose migrations to apply, from a wrangler.jsonc (comments allowed). */
export const D1_BINDINGS = String.raw`const text = require("fs").readFileSync(process.argv[1], "utf8");
let out = "", str = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i], n = text[i + 1];
  if (str) { out += c; if (c === "\\") { out += n; i++; } else if (c === '"') str = false; continue; }
  if (c === '"') { str = true; out += c; continue; }
  if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
  if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
  out += c;
}
const config = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
for (const d of config.d1_databases ?? []) if (d.binding && /^[A-Za-z_][A-Za-z0-9_]*$/.test(d.binding)) console.log(d.binding);`;

export const DEPLOY = `set -eu
export PATH="/workspace/bin:\${PATH}"
cd "/workspace/src/\${CONTEXT}"
# The repository does not configure the release: its .env files could point
# Wrangler elsewhere, and a config it wrote while building would be read
# instead of the operator's.
rm -f .env .env.* .dev.vars
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false
cp /wrangler/config/wrangler.jsonc ./.stardust.wrangler.jsonc
mkdir -p /workspace/wrangler && cd /workspace/wrangler
printf '{"private":true}' > package.json
npm install --no-audit --no-fund --ignore-scripts "wrangler@\${WRANGLER_VERSION}" >/dev/null
cd "/workspace/src/\${CONTEXT}"
W="/workspace/wrangler/node_modules/.bin/wrangler"
CONFIG="--config ./.stardust.wrangler.jsonc"
"\${W}" --version
for DB in $(node -e "\${D1_BINDINGS}" ./.stardust.wrangler.jsonc); do
  echo "[deploy] D1 migrations for \${DB}"
  "\${W}" d1 migrations apply "\${DB}" --remote \${CONFIG}
done
if [ -f /wrangler/secrets/secrets.json ]; then
  echo "[deploy] secrets"
  "\${W}" secret bulk /wrangler/secrets/secrets.json \${CONFIG}
fi
"\${W}" deploy \${CONFIG} 2>&1 | tee /workspace/deploy.log
VERSION="$(grep -oE 'Current Version ID: [0-9a-f-]{36}' /workspace/deploy.log | tail -1 | cut -d' ' -f4)"
[ -n "\${VERSION}" ] || { echo "[deploy] wrangler printed no version id" >&2; exit 1; }
echo "[stardust-worker-version] \${VERSION}"
`;

export const VERSION_LINE = /^\[stardust-worker-version\] ([0-9a-f-]{36})$/m;

export function deployJob(req: DeployRequest, options: WorkersOptions): Record<string, unknown> {
  validateDeploy(req, options);
  const images = options.images ?? DEFAULT_IMAGES;
  const config = configName(req.projectId, req.component);
  const context = req.context ?? ".";
  const labels = {
    "app.kubernetes.io/managed-by": "stardust",
    "stardust/run": req.runId,
    "stardust/job": req.jobName
      .slice(0, 63)
      .replace(/[^A-Za-z0-9_.-]/g, "-")
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""),
    "stardust/project": req.projectId.toLowerCase(),
  };
  const locked = { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, runAsNonRoot: true };
  const home = { name: "HOME", value: "/workspace/home" };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { generateName: `${config.slice(0, 50)}-`, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: options.deadlineSeconds ?? 1800,
      ttlSecondsAfterFinished: options.ttlSeconds ?? 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: {
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          initContainers: [
            {
              name: "clone",
              image: images.git,
              command: ["/bin/sh", "-c", CLONE],
              env: [
                home,
                { name: "GIT_BASE", value: options.gitBaseUrl ?? "https://github.com" },
                { name: "GIT_USERNAME", value: options.cloneUsername ?? "x-access-token" },
                { name: "REPO", value: req.repo },
                { name: "SHA", value: req.sha },
                ...(options.cloneSecret
                  ? [{ name: "GITHUB_TOKEN", valueFrom: { secretKeyRef: { name: options.cloneSecret, key: "token" } } }]
                  : []),
              ],
              securityContext: locked,
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            },
            {
              name: "build",
              image: images.node,
              command: ["/bin/sh", "-c", BUILD],
              env: [
                home,
                { name: "CONTEXT", value: context },
                { name: "NODE_OPTIONS", value: "--max-old-space-size=3072" },
                ...Object.entries(req.buildEnv ?? {}).map(([name, value]) => ({ name, value })),
              ],
              securityContext: locked,
              resources: { requests: { cpu: "200m", memory: "512Mi" }, limits: { memory: "4Gi" } },
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            },
          ],
          containers: [
            {
              name: "deploy",
              image: images.node,
              command: ["/bin/sh", "-c", DEPLOY],
              env: [
                home,
                { name: "CONTEXT", value: context },
                { name: "WRANGLER_VERSION", value: options.wranglerVersion ?? DEFAULT_WRANGLER },
                { name: "D1_BINDINGS", value: D1_BINDINGS },
                {
                  name: "CLOUDFLARE_API_TOKEN",
                  valueFrom: { secretKeyRef: { name: options.tokenSecret, key: "token" } },
                },
                // Without the account, Wrangler asks the API which accounts the token has, which a deploy token may not be allowed to.
                {
                  name: "CLOUDFLARE_ACCOUNT_ID",
                  valueFrom: { secretKeyRef: { name: options.tokenSecret, key: "account-id" } },
                },
              ],
              securityContext: locked,
              resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "1Gi" } },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "config", mountPath: "/wrangler/config", readOnly: true },
                { name: "secrets", mountPath: "/wrangler/secrets", readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "config", configMap: { name: config, items: [{ key: "wrangler.jsonc", path: "wrangler.jsonc" }] } },
            { name: "secrets", secret: { secretName: config, optional: true, defaultMode: 0o400 } },
          ],
        },
      },
    },
  };
}
