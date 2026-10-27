import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BUILD_SCRIPT,
  type BuildInput,
  buildJob,
  CLONE_SCRIPT,
  DEFAULT_IMAGES,
  DIGEST_FROM_METADATA,
  DIGEST_LINE,
  NODE_DOCKERFILE,
} from "./job.ts";

const input: BuildInput = {
  projectId: "demo",
  repo: "acme/demo",
  sha: "abcdef1234567890abcdef1234567890abcdef12",
  component: "api",
  imageRepository: "registry.example.com/demo/api",
  runId: "11111111-1111-1111-1111-111111111111",
  jobName: "build",
};
const options = { cloneSecret: "github-clone", pushSecret: "registry-push", projectSecret: "demo-secrets" };

type Container = {
  name: string;
  image: string;
  command: string[];
  env: Array<{ name: string; value?: string; valueFrom?: unknown }>;
  securityContext: Record<string, unknown>;
  volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
};
// biome-ignore lint/suspicious/noExplicitAny: walking a plain manifest object in tests
const manifest = (i: BuildInput = input) => buildJob(i, options) as any;
const pod = (m = manifest()) => m.spec.template.spec;
const clone = (m = manifest()): Container => pod(m).initContainers[0];
const build = (m = manifest()): Container => pod(m).containers[0];

describe("security properties kept from the predecessor", () => {
  it("no service account token, never restarted or retried, bounded in time, cleaned up", () => {
    const m = manifest();
    assert.equal(pod(m).automountServiceAccountToken, false);
    assert.equal(pod(m).restartPolicy, "Never");
    assert.equal(m.spec.backoffLimit, 0);
    assert.equal(m.spec.activeDeadlineSeconds, 1800);
    assert.equal(m.spec.ttlSecondsAfterFinished, 3600);
  });
  it("runs as uid 1000", () => {
    assert.equal(pod().securityContext.runAsUser, 1000);
    assert.equal(pod().securityContext.runAsGroup, 1000);
    for (const c of [clone(), build()]) assert.equal(c.securityContext.runAsNonRoot, true, c.name);
  });
  it("the registry credential is read-only and the project secret is owner-read and optional", () => {
    const volumes = pod().volumes as Array<{ name: string; secret?: Record<string, unknown> }>;
    const push = volumes.find((v) => v.name === "push-auth")?.secret;
    assert.equal(push?.defaultMode, 0o444);
    assert.equal(push?.secretName, "registry-push");
    const project = volumes.find((v) => v.name === "project-secret")?.secret;
    assert.equal(project?.defaultMode, 0o400);
    assert.equal(project?.optional, true);
    assert.ok(build().volumeMounts.every((v) => v.name === "workspace" || v.name === "buildkit-state" || v.readOnly));
  });
  it("the build time is the commit time, not the wall clock", () => {
    assert.match(CLONE_SCRIPT, /git show -s --format=%cI HEAD > \/workspace\/build-time/);
    assert.match(BUILD_SCRIPT, /BUILD_TIME="\$\(cat \/workspace\/build-time\)"/);
    assert.doesNotMatch(BUILD_SCRIPT + CLONE_SCRIPT, /\bdate\b/);
  });
});

describe("the clone credential never meets the build", () => {
  it("only the clone init container reads the clone secret", () => {
    const fromSecret = (c: Container) => c.env.filter((e) => e.valueFrom !== undefined).map((e) => e.name);
    assert.deepEqual(fromSecret(clone()), ["GITHUB_TOKEN"]);
    assert.deepEqual(fromSecret(build()), []);
    assert.ok(!build().env.some((e) => e.name === "GITHUB_TOKEN"));
    assert.ok(!JSON.stringify(build()).includes("github-clone"));
  });
  it("the token goes to git through its environment, not a URL", () => {
    assert.match(CLONE_SCRIPT, /GIT_CONFIG_VALUE_0="AUTHORIZATION: basic/);
    assert.doesNotMatch(CLONE_SCRIPT, /x-access-token:\$\{GITHUB_TOKEN\}@/);
    assert.match(CLONE_SCRIPT, /unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GITHUB_TOKEN/);
  });
  it("the clone container is locked down: no privilege, read-only root, no capabilities", () => {
    assert.deepEqual(clone().securityContext, {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
  });
});

describe("inputs cannot become shell code", () => {
  it("the scripts are the same text whatever the inputs", () => {
    const other = manifest({
      ...input,
      repo: "other/thing",
      sha: "0".repeat(40),
      component: "web",
      context: "apps/web",
      dockerfile: "docker/Dockerfile.prod",
    });
    assert.deepEqual(clone(other).command, clone().command);
    assert.deepEqual(build(other).command, build().command);
    assert.equal(clone().command[2], CLONE_SCRIPT);
    assert.equal(build().command[2], BUILD_SCRIPT);
  });
  it("inputs travel as environment variables", () => {
    const vars = Object.fromEntries(
      build()
        .env.filter((e) => e.value !== undefined)
        .map((e) => [e.name, e.value]),
    );
    assert.equal(vars.IMAGE, "registry.example.com/demo/api:abcdef1");
    assert.equal(vars.SHA, input.sha);
    assert.equal(vars.CONTEXT, ".");
    assert.equal(vars.DOCKERFILE, "Dockerfile");
  });

  const rejected: Array<[string, Partial<BuildInput>, RegExp]> = [
    ["a repo with shell syntax", { repo: "acme/demo; rm -rf /" }, /repo/],
    ["a short sha", { sha: "abcdef1" }, /sha/],
    ["an upper-case sha", { sha: "A".repeat(40) }, /sha/],
    ["a context escaping the repository", { context: "../etc" }, /context/],
    ["an absolute dockerfile", { dockerfile: "/etc/passwd" }, /dockerfile/],
    ["a tagged image repository", { imageRepository: "registry.example.com/demo/api:latest" }, /imageRepository/],
    ["an image repository without a registry path", { imageRepository: "api" }, /imageRepository/],
    ["a component that is not a DNS label", { component: "API_server" }, /component/],
  ];
  for (const [label, change, expected] of rejected) {
    it(`rejects ${label}`, () => {
      assert.throws(() => buildJob({ ...input, ...change }, options), expected);
    });
  }
});

describe("registry", () => {
  it("pushes over TLS unless an insecure registry is configured", () => {
    const names = (m: ReturnType<typeof manifest>) => build(m).env.map((e: { name: string }) => e.name);
    assert.ok(!names(manifest()).includes("REGISTRY_INSECURE"));
    const local = buildJob(input, { ...options, insecureRegistry: true }) as ReturnType<typeof manifest>;
    assert.ok(names(local).includes("REGISTRY_INSECURE"));
    assert.match(BUILD_SCRIPT, /\$\{REGISTRY_INSECURE:\+,registry\.insecure=true\}/);
  });
});

describe("git host", () => {
  it("clones from github.com by default and from a configured host otherwise", () => {
    const value = (m: ReturnType<typeof manifest>, name: string) =>
      clone(m).env.find((e: { name: string }) => e.name === name)?.value;
    assert.equal(value(manifest(), "GIT_BASE"), "https://github.com");
    const gitea = buildJob(input, { ...options, gitBaseUrl: "http://gitea.git.svc:3000" }) as ReturnType<
      typeof manifest
    >;
    assert.equal(value(gitea, "GIT_BASE"), "http://gitea.git.svc:3000");
    assert.equal(clone(gitea).command[2], CLONE_SCRIPT, "the script stays the same");
    assert.doesNotMatch(CLONE_SCRIPT, /github\.com/);
  });
  it("rejects a git base URL that is not http(s)", () => {
    for (const bad of ["ftp://x", "http://x/a b", "https://x/;rm"]) {
      assert.throws(() => buildJob(input, { ...options, gitBaseUrl: bad }), /gitBaseUrl/);
    }
  });
});

describe("job shape", () => {
  it("uses pinned images", () => {
    assert.equal(clone().image, DEFAULT_IMAGES.git);
    assert.equal(build().image, DEFAULT_IMAGES.buildkit);
    for (const image of Object.values(DEFAULT_IMAGES)) assert.match(image, /@sha256:[0-9a-f]{64}$/);
  });
  it("keeps the generated name short enough for the pod's job-name label", () => {
    const long = manifest({ ...input, projectId: "a".repeat(40), component: "b".repeat(40) });
    assert.ok(long.metadata.generateName.length + 5 <= 63);
  });
  it("labels the job with its project, run and job name", () => {
    assert.equal(manifest().metadata.labels["stardust/run"], input.runId);
    assert.equal(manifest().metadata.labels["stardust/job"], "build");
  });
  it("reads the digest line the build prints", () => {
    const log = `[build] x\n[stardust-image-digest] sha256:${"f".repeat(64)}\n`;
    assert.equal(DIGEST_LINE.exec(log)?.[1], `sha256:${"f".repeat(64)}`);
    assert.equal(DIGEST_LINE.exec("[stardust-image-digest] \n"), null);
  });
});

describe("reading the digest from BuildKit's metadata", () => {
  const IMAGE = `sha256:${"9".repeat(64)}`;
  const run = (metadata: string) => {
    const dir = mkdtempSync(join(tmpdir(), "meta-"));
    try {
      writeFileSync(join(dir, "metadata.json"), metadata);
      return execFileSync("sh", ["-c", `set -eu\n${DIGEST_FROM_METADATA}`], {
        env: { ...process.env, METADATA: join(dir, "metadata.json") },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("takes containerimage.digest, not the first digest in the file", () => {
    // Real shape: the provenance (with base image digests) and the config digest come first.
    const real = JSON.stringify(
      {
        "buildx.build.provenance": {
          materials: [{ digest: { sha256: "1".repeat(64) } }],
          ref: `x@sha256:${"2".repeat(64)}`,
        },
        "containerimage.config.digest": `sha256:${"3".repeat(64)}`,
        "containerimage.descriptor": { digest: IMAGE },
        "containerimage.digest": IMAGE,
      },
      null,
      2,
    );
    assert.equal(run(real).trim(), `[stardust-image-digest] ${IMAGE}`);
    assert.equal(DIGEST_LINE.exec(run(real))?.[1], IMAGE);
  });
  it("reads compact JSON too", () => {
    const compact = `{"containerimage.config.digest":"sha256:${"3".repeat(64)}","containerimage.digest":"${IMAGE}"}`;
    assert.equal(run(compact).trim(), `[stardust-image-digest] ${IMAGE}`);
  });
  it("fails, saying why, when the key is missing", () => {
    assert.throws(
      () => run(`{"containerimage.config.digest":"sha256:${"3".repeat(64)}"}`),
      (err: { status?: number; stderr?: string }) =>
        err.status === 1 && String(err.stderr).includes("no containerimage.digest"),
    );
  });
  it("is the tail of the build script", () => {
    assert.ok(BUILD_SCRIPT.endsWith(DIGEST_FROM_METADATA));
  });
});

describe("node builds", () => {
  const node: BuildInput = {
    ...input,
    kind: "node",
    port: 8080,
    buildEnv: { BUILD_TARGET: "node", DB_DIALECT: "postgres" },
  };
  const envOf = (m: ReturnType<typeof manifest>) => Object.fromEntries(build(m).env.map((e) => [e.name, e.value]));

  it("run the same constant script, with the constant Dockerfile and pinned Node image in the environment", () => {
    const m = manifest(node);
    assert.equal(build(m).command[2], BUILD_SCRIPT);
    const env = envOf(m);
    assert.equal(env.BUILD_KIND, "node");
    assert.equal(env.NODE_DOCKERFILE, NODE_DOCKERFILE);
    assert.match(env.NODE_IMAGE ?? "", /^node:22\.[0-9.]+-bookworm-slim@sha256:[0-9a-f]{64}$/);
    assert.equal(env.PORT, "8080");
  });

  it("carry the build environment encoded, one KEY=value line each, decoded only inside the build", () => {
    const decoded = Buffer.from(envOf(manifest(node)).BUILD_ENV_B64 ?? "", "base64").toString();
    assert.equal(decoded, "BUILD_TARGET=node\nDB_DIALECT=postgres\n");
    // A value that looks like shell stays a value: the Dockerfile exports lines, it never evaluates them.
    const tricky = manifest({ ...node, buildEnv: { X: "$(touch /pwned); `id`" } });
    assert.equal(Buffer.from(envOf(tricky).BUILD_ENV_B64 ?? "", "base64").toString(), "X=$(touch /pwned); `id`\n");
    assert.match(NODE_DOCKERFILE, /export "\$line"/);
    assert.doesNotMatch(NODE_DOCKERFILE, /\beval\b|\bsource\b|^\s*\. /m);
  });

  it("refuse names that are not environment names, control characters, bad ports and a Dockerfile", () => {
    for (const [change, expected] of [
      [{ buildEnv: { "lower-case": "x" } }, /UPPER_CASE_NAME/],
      [{ buildEnv: { "A=B": "x" } }, /UPPER_CASE_NAME/],
      [{ buildEnv: { OK: "line\nINJECTED=1" } }, /control character/],
      [{ port: 70000 }, /not a TCP port/],
      [{ dockerfile: "Dockerfile" }, /no dockerfile of its own/],
    ] as const) {
      assert.throws(() => buildJob({ ...node, ...change } as BuildInput, options), expected);
    }
    assert.throws(() => buildJob({ ...input, port: 3000 }, options), /node builds only/);
  });

  it("leave Dockerfile builds as they were", () => {
    const env = envOf(manifest());
    assert.equal(env.BUILD_KIND, "dockerfile");
    assert.equal(env.NODE_DOCKERFILE, undefined);
  });
});
