/**
 * The Kubernetes Job that builds one container image with rootless BuildKit.
 *
 * Two containers, so the clone credential never meets the build:
 * - init `clone` (git) has the clone token and writes the source and the
 *   commit time into an emptyDir;
 * - `build` (rootless BuildKit) has the registry push credential only.
 *
 * Inputs reach the scripts through environment variables, never by being
 * spliced into the script text, so no repository name, ref or path can turn
 * into shell code. The scripts are constants; a test holds them identical
 * across inputs.
 *
 * Kept from the predecessor's build Job: no service account token,
 * restartPolicy Never, no retries, a deadline, cleanup after completion,
 * uid 1000, a read-only registry credential and an optional read-only project
 * secret, and the commit time (not the wall clock) as the build time so the
 * same commit builds the same image.
 */

export const DEFAULT_IMAGES = {
  buildkit: "moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89",
  git: "alpine/git:v2.54.0@sha256:e8ceedc73bd80992ae8d58a7d24c58b8322146c354f1d2e81a97db4452068ec0",
} as const;

export const LABEL_PREFIX = "stardust";

export interface BuildInput {
  projectId: string;
  /** GitHub `owner/name`. */
  repo: string;
  /** Full commit SHA to build. */
  sha: string;
  component: string;
  /** Image name without tag, e.g. `registry.example.com/demo/api`. */
  imageRepository: string;
  /** Path of the Dockerfile and build context inside the repository. Defaults to the root. */
  context?: string;
  dockerfile?: string;
  /** Run id and job name, for labels. */
  runId: string;
  jobName: string;
}

export interface BuilderOptions {
  /** Base URL of the Git host to clone from. Defaults to https://github.com. */
  gitBaseUrl?: string;
  /** Push over plain HTTP. Only for local registries such as a kind test cluster. */
  insecureRegistry?: boolean;
  /** Secret with key `token`: a GitHub token that can read the repository. */
  cloneSecret: string;
  /** Secret with key `config.json`: a docker config that can push to the registry. */
  pushSecret: string;
  /** Optional per-project secret mounted read-only at /run/secrets/project. */
  projectSecret?: string;
  images?: { buildkit: string; git: string };
  deadlineSeconds?: number;
  ttlSeconds?: number;
  resources?: { requests: Record<string, string>; limits: Record<string, string> };
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const IMAGE_REPOSITORY = /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/;
const GIT_BASE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._-]+)*$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]+$/;

export class BuildInputError extends Error {}

export function validateBuildInput(input: BuildInput): void {
  const problems: string[] = [];
  if (!NAME.test(input.projectId)) problems.push(`projectId "${input.projectId}" is not a DNS label`);
  if (!NAME.test(input.component)) problems.push(`component "${input.component}" is not a DNS label`);
  if (!REPO.test(input.repo)) problems.push(`repo "${input.repo}" is not owner/name`);
  if (!SHA.test(input.sha)) problems.push("sha must be a full 40-character lower-case SHA");
  if (!IMAGE_REPOSITORY.test(input.imageRepository)) {
    problems.push(`imageRepository "${input.imageRepository}" is not a registry/path image name without a tag`);
  }
  for (const [key, value] of [
    ["context", input.context],
    ["dockerfile", input.dockerfile],
  ] as const) {
    if (value !== undefined && !RELATIVE_PATH.test(value)) {
      problems.push(`${key} "${value}" must be a relative path inside the repository`);
    }
  }
  if (problems.length > 0) throw new BuildInputError(`invalid build input: ${problems.join("; ")}`);
}

/**
 * The token reaches git as an HTTP header through git's environment-based
 * configuration (GIT_CONFIG_COUNT), so it is neither in a URL nor on any
 * process's command line, and it is written to no file.
 */
export const CLONE_SCRIPT = `set -eu
mkdir -p "\${HOME}"
git init -q /workspace/src
cd /workspace/src
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.\${GIT_BASE}/.extraheader"
GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "\${GITHUB_TOKEN}" | base64 | tr -d '\\n')"
export GIT_CONFIG_VALUE_0
git fetch -q --depth 1 "\${GIT_BASE}/\${REPO}.git" "\${SHA}"
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GITHUB_TOKEN
git checkout -q --detach FETCH_HEAD
git show -s --format=%cI HEAD > /workspace/build-time
echo "[clone] \${REPO} @ \${SHA}"
`;

export const BUILD_SCRIPT = `set -eu
cd /workspace/src
BUILD_TIME="$(cat /workspace/build-time)"
echo "[build] \${IMAGE} context=\${CONTEXT} dockerfile=\${DOCKERFILE}"
buildctl-daemonless.sh build \\
  --frontend dockerfile.v0 \\
  --local "context=\${CONTEXT}" \\
  --local "dockerfile=\${CONTEXT}" \\
  --opt "filename=\${DOCKERFILE}" \\
  --opt "build-arg:BUILD_SHA=\${SHA}" \\
  --opt "build-arg:BUILD_TIME=\${BUILD_TIME}" \\
  --output "type=image,name=\${IMAGE},push=true,oci-mediatypes=true\${REGISTRY_INSECURE:+,registry.insecure=true}" \\
  --metadata-file /workspace/metadata.json
DIGEST="$(grep -o 'sha256:[0-9a-f]\\{64\\}' /workspace/metadata.json | head -1)"
echo "[stardust-image-digest] \${DIGEST}"
`;

/** The line the build prints with the pushed image's digest; the executor reads it from the log. */
export const DIGEST_LINE = /^\[stardust-image-digest\] (sha256:[0-9a-f]{64})$/m;

const env = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

export function buildJob(input: BuildInput, options: BuilderOptions): Record<string, unknown> {
  validateBuildInput(input);
  const gitBase = options.gitBaseUrl ?? "https://github.com";
  if (!GIT_BASE.test(gitBase)) throw new BuildInputError(`gitBaseUrl "${gitBase}" is not an http(s) base URL`);
  const images = options.images ?? DEFAULT_IMAGES;
  const short = input.sha.slice(0, 7);
  const image = `${input.imageRepository}:${short}`;
  const labels = {
    "app.kubernetes.io/managed-by": "stardust",
    "app.kubernetes.io/component": "build",
    [`${LABEL_PREFIX}/project`]: input.projectId,
    [`${LABEL_PREFIX}/run`]: input.runId,
    [`${LABEL_PREFIX}/job`]: input.jobName,
  };
  const restricted = {
    runAsNonRoot: true,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      generateName: `build-${input.projectId}-${input.component}-${short}-`.slice(0, 57),
      labels,
      annotations: {
        [`${LABEL_PREFIX}/repo`]: input.repo,
        [`${LABEL_PREFIX}/sha`]: input.sha,
        [`${LABEL_PREFIX}/image`]: image,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: options.deadlineSeconds ?? 1800,
      ttlSecondsAfterFinished: options.ttlSeconds ?? 3600,
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: "Never",
          securityContext: {
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
          },
          initContainers: [
            {
              name: "clone",
              image: images.git,
              command: ["sh", "-c", CLONE_SCRIPT],
              env: [
                ...env({ GIT_BASE: gitBase, REPO: input.repo, SHA: input.sha, HOME: "/workspace/home" }),
                {
                  name: "GITHUB_TOKEN",
                  valueFrom: { secretKeyRef: { name: options.cloneSecret, key: "token" } },
                },
              ],
              securityContext: { ...restricted, seccompProfile: { type: "RuntimeDefault" } },
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            },
          ],
          containers: [
            {
              name: "build",
              image: images.buildkit,
              command: ["sh", "-c", BUILD_SCRIPT],
              env: env({
                IMAGE: image,
                SHA: input.sha,
                CONTEXT: input.context ?? ".",
                DOCKERFILE: input.dockerfile ?? "Dockerfile",
                BUILDKITD_FLAGS: "--oci-worker-no-process-sandbox",
                DOCKER_CONFIG: "/home/user/.docker",
                ...(options.insecureRegistry ? { REGISTRY_INSECURE: "true" } : {}),
              }),
              // Rootless BuildKit needs unconfined seccomp and AppArmor to set up
              // its user namespace; it still runs as uid 1000 without privilege.
              securityContext: {
                runAsNonRoot: true,
                seccompProfile: { type: "Unconfined" },
                appArmorProfile: { type: "Unconfined" },
              },
              resources: options.resources ?? {
                requests: { cpu: "200m", memory: "512Mi" },
                limits: { cpu: "2", memory: "3Gi" },
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "buildkit-state", mountPath: "/home/user/.local/share/buildkit" },
                { name: "push-auth", mountPath: "/home/user/.docker", readOnly: true },
                ...(options.projectSecret
                  ? [{ name: "project-secret", mountPath: "/run/secrets/project", readOnly: true }]
                  : []),
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "buildkit-state", emptyDir: {} },
            {
              name: "push-auth",
              secret: {
                secretName: options.pushSecret,
                defaultMode: 0o444,
                items: [{ key: "config.json", path: "config.json" }],
              },
            },
            ...(options.projectSecret
              ? [
                  {
                    name: "project-secret",
                    secret: { secretName: options.projectSecret, defaultMode: 0o400, optional: true },
                  },
                ]
              : []),
          ],
        },
      },
    },
  };
}
