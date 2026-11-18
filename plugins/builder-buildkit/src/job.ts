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

import { digestOf, hasControlCharacter, PINNED_IMAGE } from "@stardust/core";

export const DEFAULT_IMAGES = {
  buildkit: "moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89",
  git: "alpine/git:v2.54.0@sha256:e8ceedc73bd80992ae8d58a7d24c58b8322146c354f1d2e81a97db4452068ec0",
  /** Copies mirrored images; the debug image has the shell the Job script needs. */
  crane:
    "gcr.io/go-containerregistry/crane/debug:v0.22.1@sha256:e78770b31258a3846f878036d9c1f63fbe4c871f9f56990bf77fd95c013e3c1b",
  /** Moves a component's BuildKit state to and from object storage (stateCache). */
  rclone: "rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5",
  /** Base of `kind: "node"` builds. */
  node: "node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d",
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
  /** "dockerfile" (default) builds the repository's Dockerfile; "node" builds a Node app with NODE_DOCKERFILE; "mirror" copies `source`. */
  kind?: "dockerfile" | "node" | "mirror";
  /** kind "mirror": the published image, pinned by digest. */
  source?: string;
  /** False for code nobody here reviewed: no clone token, no project secret. */
  trusted?: boolean;
  /**
   * The Job's own name and the Secret (key `token`) its clone step reads,
   * for a one-time token: the Job is created suspended, released once the
   * Secret exists.
   */
  oneTimeClone?: { jobName: string; secret: string };
  /** Port the Node app listens on (kind "node"). */
  port?: number;
  /** Environment during the Node build (kind "node"), e.g. which adapter or database driver to compile in. Not secret. */
  buildEnv?: Record<string, string>;
  /** Run id and job name, for labels. */
  runId: string;
  jobName: string;
}

export interface StateCacheOptions {
  /** S3 endpoint, e.g. `http://10.0.0.5:9000`. */
  endpoint: string;
  bucket: string;
  /** Secret with keys `access-key` and `secret-key`, for the bucket only. */
  secret: string;
  region?: string;
  /** Largest state kept, in bytes; BuildKit's GC keeps the state under it before it is packed. Default 10 GiB. */
  maxBytes?: number;
  /** `<project>/<component>` entries that use it. */
  components: string[];
}

export interface BuilderOptions {
  /** Base URL of the Git host to clone from. Defaults to https://github.com. */
  gitBaseUrl?: string;
  /** User name sent with the clone token. GitHub ignores it; Gitea wants the token's owner. */
  cloneUsername?: string;
  /** Push over plain HTTP. Only for local registries such as a kind test cluster. */
  insecureRegistry?: boolean;
  /**
   * Layer cache between builds, kept in the registry next to the image as
   * `<repository>:buildcache` (one per component, so projects never share one).
   * "registry" (the default) imports it before building and exports every layer
   * after; "off" builds from scratch each time. A build of someone else's code
   * (trusted: false) never reads or writes it.
   */
  cache?: "registry" | "off";
  /**
   * The whole BuildKit state of chosen components, kept in S3-compatible
   * storage between builds: layers and also `RUN --mount=type=cache` contents
   * (a Rust target directory, a package cache), which no registry cache holds.
   * Restored before the build and saved after it, each by a container of its
   * own that holds the storage credential; the build container never sees it.
   * The state is packed and unpacked inside BuildKit's user namespace, where
   * its files' owners are real, as a plain tar (storage is meant to be close:
   * compressing gigabytes costs more than sending them), and a build that
   * wrote nothing new into it saves nothing. A missing, broken or failed transfer means a
   * cold build, never a failed one. Builds of someone else's code use none.
   */
  stateCache?: StateCacheOptions;
  /**
   * Secret with key `token`: a GitHub token that can read the repository.
   * Without it the clone is anonymous, which works for public repositories only.
   */
  cloneSecret?: string;
  /** Secret with key `config.json`: a docker config that can push to the registry. */
  pushSecret: string;
  /** Optional per-project secret mounted read-only at /run/secrets/project. */
  projectSecret?: string;
  images?: { buildkit: string; git: string; node?: string; crane?: string; rclone?: string };
  deadlineSeconds?: number;
  ttlSeconds?: number;
  resources?: { requests: Record<string, string>; limits: Record<string, string> };
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const IMAGE_REPOSITORY = /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/;
const GIT_BASE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._-]+)*$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
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
  if (input.kind === "mirror") {
    if (typeof input.source !== "string" || !PINNED_IMAGE.test(input.source)) {
      problems.push("a mirror needs source: the published image pinned by digest");
    }
    if (input.context !== undefined || input.dockerfile !== undefined)
      problems.push("a mirror builds nothing: no context or dockerfile");
  } else if (input.source !== undefined) {
    problems.push("source applies to mirrors only");
  }
  if (input.kind === "node") {
    if (input.dockerfile !== undefined) problems.push("a node build uses no dockerfile of its own");
    if (input.port !== undefined && !(Number.isInteger(input.port) && input.port >= 1 && input.port <= 65535)) {
      problems.push(`port ${input.port} is not a TCP port`);
    }
    for (const [key, value] of Object.entries(input.buildEnv ?? {})) {
      if (!ENV_KEY.test(key)) problems.push(`buildEnv key "${key}" must look like UPPER_CASE_NAME`);
      if (hasControlCharacter(value)) problems.push(`buildEnv ${key} contains a control character`);
    }
  } else if (input.port !== undefined || input.buildEnv !== undefined) {
    problems.push("port and buildEnv apply to node builds only");
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
if [ -n "\${GITHUB_TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="http.\${GIT_BASE}/.extraheader"
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf '%s:%s' "\${GIT_USERNAME}" "\${GITHUB_TOKEN}" | base64 | tr -d '\\n')"
  export GIT_CONFIG_VALUE_0
fi
git fetch -q --depth 1 "\${GIT_BASE}/\${REPO}.git" "\${SHA}"
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GITHUB_TOKEN
git checkout -q --detach FETCH_HEAD
git show -s --format=%cI HEAD > /workspace/build-time
echo "[clone] \${REPO} @ \${SHA}"
`;

/**
 * Prints the pushed image's digest from BuildKit's metadata file. It must be
 * read from the `containerimage.digest` key: the file also holds other
 * digests (the image config, the base images in the provenance) and any of
 * them can come first, and deploying one of those fails at pull time.
 */
export const DIGEST_FROM_METADATA = `DIGEST="$(grep -o '"containerimage\\.digest"[[:space:]]*:[[:space:]]*"sha256:[0-9a-f]\\{64\\}"' "\${METADATA:-/workspace/metadata.json}" | grep -o 'sha256:[0-9a-f]\\{64\\}' || true)"
if [ -z "\${DIGEST}" ]; then
  echo "[build] no containerimage.digest in the build metadata" >&2
  exit 1
fi
echo "[stardust-image-digest] \${DIGEST}"
`;

/**
 * The pnpm that `kind: "node"` builds install with, unless the app's
 * `package.json` names a pnpm of its own in `packageManager`.
 */
export const NODE_BUILD_PNPM = "12.14.0";

/**
 * The Dockerfile for `kind: "node"` builds: a Node application without a
 * Dockerfile of its own, installed with pnpm, built with its `build` script and
 * run by node from `build/` (the SvelteKit adapter-node layout). It is a
 * constant: the Node image, the port and the build environment arrive as build
 * arguments, and the build environment is decoded and exported one `KEY=value`
 * line at a time, never evaluated by a shell.
 *
 * Every app installs with pnpm, whatever lockfile it carries:
 * - `pnpm-lock.yaml` is used as it is (`--frozen-lockfile`);
 * - an npm or yarn lockfile is turned into one with `pnpm import`, so the
 *   versions it pinned are the versions installed;
 * - a lockfile pnpm cannot read (bun's), one `pnpm import` refuses, or none at
 *   all: the dependencies are resolved fresh from `package.json`;
 * - lockfiles of more than one package manager: the build stops, since nothing
 *   says which of them is meant.
 * The build log names the way that was taken (`[node-build] install: …`).
 *
 * Carried over from the predecessor, where each line came from a failed start:
 * install scripts do not run (`--ignore-scripts`); `server.js` and
 * `shutdown.js` are copied when present and `server.js` is preferred over
 * `build/index.js` (a custom server that terminates TLS, and the module it
 * imports for shutdown). An app without dependencies gets an empty
 * node_modules, which a package manager does not create (found by the fixture).
 */
export const NODE_DOCKERFILE = `# syntax=docker/dockerfile:1
ARG NODE_IMAGE
FROM \${NODE_IMAGE} AS build
ARG BUILD_ENV=""
WORKDIR /app
# An app whose packageManager names npm or yarn still installs with pnpm: corepack
# would refuse to run pnpm there (strict), and so would pnpm itself (pm_on_fail).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_STRICT=0 pnpm_config_pm_on_fail=ignore
RUN corepack enable && corepack prepare pnpm@${NODE_BUILD_PNPM} --activate
COPY . ./
RUN set -e; \\
    printf '%s' "\${BUILD_ENV}" | base64 -d > /tmp/build.env; \\
    while IFS= read -r line; do if [ -n "$line" ]; then export "$line"; fi; done < /tmp/build.env; \\
    rm /tmp/build.env; \\
    found=""; kinds=""; \\
    for f in pnpm-lock.yaml package-lock.json npm-shrinkwrap.json yarn.lock bun.lock bun.lockb; do \\
      [ -f "$f" ] || continue; found="$found $f"; \\
      case "$f" in pnpm-lock.yaml) k=pnpm;; package-lock.json|npm-shrinkwrap.json) k=npm;; yarn.lock) k=yarn;; *) k=bun;; esac; \\
      case " $kinds " in *" $k "*) ;; *) kinds="$kinds $k";; esac; \\
    done; \\
    set -- $kinds; \\
    if [ "$#" -gt 1 ]; then echo "[node-build] lockfiles of more than one package manager:$found; keep one" >&2; exit 1; fi; \\
    case "\${1:-}" in \\
      pnpm) echo "[node-build] install: pnpm-lock.yaml, frozen"; pnpm install --frozen-lockfile --ignore-scripts;; \\
      npm|yarn) \\
        if pnpm import; then echo "[node-build] install: imported$found into pnpm-lock.yaml"; pnpm install --frozen-lockfile --ignore-scripts; \\
        else echo "[node-build] install:$found could not be imported, resolving fresh"; rm -f pnpm-lock.yaml; pnpm install --no-frozen-lockfile --ignore-scripts; fi;; \\
      bun) echo "[node-build] install:$found is not a lockfile pnpm reads, resolving fresh"; pnpm install --no-frozen-lockfile --ignore-scripts;; \\
      *) echo "[node-build] install: no lockfile, resolving fresh"; pnpm install --no-frozen-lockfile --ignore-scripts;; \\
    esac; \\
    pnpm run build; \\
    mkdir -p node_modules

FROM \${NODE_IMAGE}
ARG PORT=3000
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/package.json /app/server.js* /app/shutdown.js* ./
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production PORT=\${PORT}
EXPOSE \${PORT}
# By number, not by name: with runAsNonRoot, Kubernetes refuses an image whose
# user it cannot tell is not root (the official images' "node" is 1000).
USER 1000:1000
CMD ["sh", "-c", "if [ -f server.js ]; then exec node server.js; else exec node build/index.js; fi"]
`;

/** Where the build container's BuildKit keeps its state (the buildkit-state volume). */
export const BUILDKIT_STATE_DIR = "/home/user/.local/share/buildkit";

/** rclone's configuration from the environment, for the two state-cache containers. */
const RCLONE_ENV = `export RCLONE_CONFIG_STATE_TYPE=s3 RCLONE_CONFIG_STATE_PROVIDER=Minio RCLONE_CONFIG_STATE_ENV_AUTH=false
export RCLONE_CONFIG_STATE_ENDPOINT="\${STATE_ENDPOINT}" RCLONE_CONFIG_STATE_REGION="\${STATE_REGION:-us-east-1}"
export RCLONE_CONFIG_STATE_ACCESS_KEY_ID="\${STATE_ACCESS_KEY}" RCLONE_CONFIG_STATE_SECRET_ACCESS_KEY="\${STATE_SECRET_KEY}"
export HOME=/state-archive RCLONE_CACHE_DIR=/state-archive/.rclone`;

/** Fetches the packed state, as an opaque file. Never fails: without it the build is cold. */
export const STATE_RESTORE_SCRIPT = `set -u
${RCLONE_ENV}
if rclone copyto --s3-no-check-bucket "state:\${STATE_BUCKET}/\${STATE_KEY}" /state-archive/in.tar 2>/dev/null; then
  echo "[state-cache] fetched $(wc -c < /state-archive/in.tar | tr -d ' ')B"
else
  rm -f /state-archive/in.tar
  echo "[state-cache] none yet: a cold build"
fi
exit 0`;

/** Stores what the build packed. Never fails: the image is what matters. */
export const STATE_SAVE_SCRIPT = `set -u
${RCLONE_ENV}
if [ ! -f /state-archive/out.tar ]; then echo "[state-cache] nothing to save"; exit 0; fi
if rclone copyto --s3-no-check-bucket /state-archive/out.tar "state:\${STATE_BUCKET}/\${STATE_KEY}"; then
  echo "[state-cache] saved $(wc -c < /state-archive/out.tar | tr -d ' ')B"
else
  echo "[state-cache] saving failed; the build did not"
fi
exit 0`;

export const BUILD_SCRIPT = `set -eu
STATE_DIR="${BUILDKIT_STATE_DIR}"
# The state's files belong to users of BuildKit's user namespace, so it is
# unpacked and packed inside one (rootlesskit), where their owners are real.
if [ -n "\${STATE_ARCHIVE:-}" ] && [ -f "\${STATE_ARCHIVE}/in.tar" ]; then
  if rootlesskit tar -xf "\${STATE_ARCHIVE}/in.tar" -C "\${STATE_DIR}"; then
    # Anything written after this marker is new work worth saving.
    touch "\${STATE_ARCHIVE}/unpacked"
    echo "[state-cache] unpacked"
  else
    echo "[state-cache] unpacking failed: a cold build"
    rootlesskit sh -c 'find "$1" -mindepth 1 -delete' sh "\${STATE_DIR}" || true
  fi
  rm -f "\${STATE_ARCHIVE}/in.tar"
fi
cd /workspace/src
BUILD_TIME="$(cat /workspace/build-time)"
DOCKERFILE_DIR="\${CONTEXT}"
set --
if [ "\${BUILD_KIND}" = node ]; then
  # The Dockerfile is the constant NODE_DOCKERFILE, handed over in the environment.
  DOCKERFILE_DIR=/workspace/node-dockerfile
  DOCKERFILE=Dockerfile
  mkdir -p "\${DOCKERFILE_DIR}"
  printf '%s' "\${NODE_DOCKERFILE}" > "\${DOCKERFILE_DIR}/Dockerfile"
  set -- --opt "build-arg:NODE_IMAGE=\${NODE_IMAGE}" --opt "build-arg:PORT=\${PORT}" --opt "build-arg:BUILD_ENV=\${BUILD_ENV_B64}"
fi
# The layer cache in the registry: a missing one is only a warning, and a failed
# export does not fail the build (the image is what matters).
if [ -n "\${CACHE_REF:-}" ]; then
  set -- "$@" --import-cache "type=registry,ref=\${CACHE_REF}\${REGISTRY_INSECURE:+,registry.insecure=true}" \\
    --export-cache "type=registry,ref=\${CACHE_REF},mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true\${REGISTRY_INSECURE:+,registry.insecure=true}"
fi
echo "[build] \${IMAGE} kind=\${BUILD_KIND} context=\${CONTEXT} dockerfile=\${DOCKERFILE} cache=\${CACHE_REF:-off}"
buildctl-daemonless.sh build \\
  --frontend dockerfile.v0 \\
  --local "context=\${CONTEXT}" \\
  --local "dockerfile=\${DOCKERFILE_DIR}" \\
  --opt "filename=\${DOCKERFILE}" \\
  "$@" \\
  --opt "build-arg:BUILD_SHA=\${SHA}" \\
  --opt "build-arg:BUILD_TIME=\${BUILD_TIME}" \\
  --output "type=image,name=\${IMAGE},push=true,oci-mediatypes=true\${REGISTRY_INSECURE:+,registry.insecure=true}" \\
  --metadata-file /workspace/metadata.json
if [ -n "\${STATE_ARCHIVE:-}" ]; then
  KEEP_MB=$(( \${STATE_MAX_BYTES} / 1048576 ))
  buildctl-daemonless.sh prune --keep-storage "\${KEEP_MB}" >/dev/null 2>&1 || echo "[state-cache] prune failed"
  # A build that only reused the state changes nothing but BuildKit's own databases: keep the archive there is.
  # Looked for inside the user namespace too, where every directory of the state can be read.
  if [ -f "\${STATE_ARCHIVE}/unpacked" ] && [ -z "$(rootlesskit find "\${STATE_DIR}" -newer "\${STATE_ARCHIVE}/unpacked" -type f ! -name '*.db' ! -name '*.lock' -print 2>/dev/null | head -n 1)" ]; then
    echo "[state-cache] unchanged: not saved"
  elif rootlesskit tar -cf "\${STATE_ARCHIVE}/out.tar" -C "\${STATE_DIR}" .; then
    SIZE="$(wc -c < "\${STATE_ARCHIVE}/out.tar" | tr -d ' ')"
    if [ "\${SIZE}" -gt "\${STATE_MAX_BYTES}" ]; then
      rm -f "\${STATE_ARCHIVE}/out.tar"; echo "[state-cache] \${SIZE}B is over the limit: not saved"
    else
      echo "[state-cache] packed \${SIZE}B"
    fi
  else
    rm -f "\${STATE_ARCHIVE}/out.tar"; echo "[state-cache] packing failed: not saved"
  fi
fi
${DIGEST_FROM_METADATA}`;

/** The line the build prints with the pushed image's digest; the executor reads it from the log. */
/**
 * The container whose log holds a Job's outcome (the digest line) and its
 * build log, whatever the Job does: the executor and the log reader read it
 * by this name, so a Job that names it otherwise reports no digest.
 */
export const BUILD_CONTAINER = "build";

export const DIGEST_LINE = /^\[stardust-image-digest\] (sha256:[0-9a-f]{64})$/m;

const env = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

/**
 * Copies a published image, pinned by digest, into our registry: no code of
 * the project runs, and the copy must have the same digest as the pin.
 */
export const MIRROR_SCRIPT = `set -eu
crane copy \${INSECURE:+--insecure} "\${SOURCE}" "\${TARGET}"
GOT="$(crane digest \${INSECURE:+--insecure} "\${TARGET}")"
if [ "\${GOT}" != "\${EXPECT}" ]; then echo "[mirror] the copy is \${GOT}, the pin is \${EXPECT}" >&2; exit 1; fi
echo "[stardust-image-digest] \${GOT}"
`;

const DEFAULT_STATE_MAX_BYTES = 10 * 1024 ** 3;

/** The state cache a build uses: only a listed component's, and never for someone else's code. */
function stateCacheFor(input: BuildInput, options: BuilderOptions): StateCacheOptions | null {
  const s = options.stateCache;
  if (!s || input.trusted === false || input.kind === "mirror") return null;
  return s.components.includes(`${input.projectId}/${input.component}`) ? s : null;
}

export function buildJob(input: BuildInput, options: BuilderOptions): Record<string, unknown> {
  validateBuildInput(input);
  if (input.kind === "mirror") return mirrorJob(input, options);
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

  // With a state cache the build is an init container between the restore and the save,
  // so the save runs only after it; its log and digest line are read by name either way.
  const state = stateCacheFor(input, options);
  const stateEnv = state
    ? [
        ...env({
          STATE_ENDPOINT: state.endpoint,
          STATE_BUCKET: state.bucket,
          STATE_KEY: `${input.projectId}/${input.component}.tar`,
          ...(state.region ? { STATE_REGION: state.region } : {}),
        }),
        { name: "STATE_ACCESS_KEY", valueFrom: { secretKeyRef: { name: state.secret, key: "access-key" } } },
        { name: "STATE_SECRET_KEY", valueFrom: { secretKeyRef: { name: state.secret, key: "secret-key" } } },
      ]
    : [];
  const stateContainer = (name: string, script: string) => ({
    name,
    image: images.rclone ?? DEFAULT_IMAGES.rclone,
    command: ["/bin/sh", "-c", script],
    env: stateEnv,
    securityContext: { ...restricted, seccompProfile: { type: "RuntimeDefault" } },
    resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "256Mi" } },
    volumeMounts: [{ name: "state-archive", mountPath: "/state-archive" }],
  });
  const buildContainer = {
    name: BUILD_CONTAINER,
    image: images.buildkit,
    command: ["sh", "-c", BUILD_SCRIPT],
    env: env({
      IMAGE: image,
      SHA: input.sha,
      CONTEXT: input.context ?? ".",
      DOCKERFILE: input.dockerfile ?? "Dockerfile",
      BUILD_KIND: input.kind ?? "dockerfile",
      ...(input.kind === "node"
        ? {
            NODE_DOCKERFILE,
            NODE_IMAGE: images.node ?? DEFAULT_IMAGES.node,
            PORT: String(input.port ?? 3000),
            BUILD_ENV_B64: Buffer.from(
              Object.entries(input.buildEnv ?? {})
                .map(([k, v]) => `${k}=${v}\n`)
                .join(""),
            ).toString("base64"),
          }
        : {}),
      BUILDKITD_FLAGS: "--oci-worker-no-process-sandbox",
      DOCKER_CONFIG: "/home/user/.docker",
      ...(options.insecureRegistry ? { REGISTRY_INSECURE: "true" } : {}),
      ...((options.cache ?? "registry") === "registry" && input.trusted !== false
        ? { CACHE_REF: `${input.imageRepository}:buildcache` }
        : {}),
      ...(state
        ? { STATE_ARCHIVE: "/state-archive", STATE_MAX_BYTES: String(state.maxBytes ?? DEFAULT_STATE_MAX_BYTES) }
        : {}),
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
      ...(state ? [{ name: "state-archive", mountPath: "/state-archive" }] : []),
      ...(options.projectSecret && input.trusted !== false
        ? [{ name: "project-secret", mountPath: "/run/secrets/project", readOnly: true }]
        : []),
    ],
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      ...(input.oneTimeClone
        ? { name: input.oneTimeClone.jobName }
        : { generateName: `build-${input.projectId}-${input.component}-${short}-`.slice(0, 57) }),
      labels,
      annotations: {
        [`${LABEL_PREFIX}/repo`]: input.repo,
        [`${LABEL_PREFIX}/sha`]: input.sha,
        [`${LABEL_PREFIX}/image`]: image,
      },
    },
    spec: {
      // Held until the one-time clone token's Secret exists.
      ...(input.oneTimeClone ? { suspend: true } : {}),
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
                ...env({
                  GIT_BASE: gitBase,
                  GIT_USERNAME: options.cloneUsername ?? "x-access-token",
                  REPO: input.repo,
                  SHA: input.sha,
                  HOME: "/workspace/home",
                }),
                ...(input.oneTimeClone && input.trusted !== false
                  ? [
                      {
                        name: "GITHUB_TOKEN",
                        valueFrom: { secretKeyRef: { name: input.oneTimeClone.secret, key: "token" } },
                      },
                    ]
                  : options.cloneSecret && input.trusted !== false
                    ? [
                        {
                          name: "GITHUB_TOKEN",
                          valueFrom: { secretKeyRef: { name: options.cloneSecret, key: "token" } },
                        },
                      ]
                    : []),
              ],
              securityContext: { ...restricted, seccompProfile: { type: "RuntimeDefault" } },
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            },
            ...(state ? [stateContainer("cache-restore", STATE_RESTORE_SCRIPT), buildContainer] : []),
          ],
          containers: state ? [stateContainer("cache-save", STATE_SAVE_SCRIPT)] : [buildContainer],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "buildkit-state", emptyDir: {} },
            ...(state ? [{ name: "state-archive", emptyDir: {} }] : []),
            {
              name: "push-auth",
              secret: {
                secretName: options.pushSecret,
                defaultMode: 0o444,
                items: [{ key: "config.json", path: "config.json" }],
              },
            },
            ...(options.projectSecret && input.trusted !== false
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

function mirrorJob(input: BuildInput, options: BuilderOptions): Record<string, unknown> {
  const images = options.images ?? DEFAULT_IMAGES;
  const short = input.sha.slice(0, 7);
  const source = input.source ?? "";
  const labels = {
    "app.kubernetes.io/managed-by": "stardust",
    "app.kubernetes.io/component": "build",
    [`${LABEL_PREFIX}/project`]: input.projectId,
    [`${LABEL_PREFIX}/run`]: input.runId,
    [`${LABEL_PREFIX}/job`]: input.jobName,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      generateName: `mirror-${input.projectId}-${input.component}-`.slice(0, 57),
      labels,
      annotations: {
        [`${LABEL_PREFIX}/source`]: source,
        [`${LABEL_PREFIX}/image`]: `${input.imageRepository}:${short}`,
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
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: BUILD_CONTAINER,
              image: images.crane ?? DEFAULT_IMAGES.crane,
              command: ["/busybox/sh", "-c", MIRROR_SCRIPT],
              env: env({
                SOURCE: source,
                TARGET: `${input.imageRepository}:${short}`,
                EXPECT: digestOf(source) ?? "",
                DOCKER_CONFIG: "/home/user/.docker",
                ...(options.insecureRegistry ? { INSECURE: "1" } : {}),
              }),
              securityContext: {
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "512Mi" } },
              volumeMounts: [{ name: "push-auth", mountPath: "/home/user/.docker", readOnly: true }],
            },
          ],
          volumes: [
            {
              name: "push-auth",
              secret: {
                secretName: options.pushSecret,
                defaultMode: 0o444,
                items: [{ key: "config.json", path: "config.json" }],
              },
            },
          ],
        },
      },
    },
  };
}
