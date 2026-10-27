import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILD_SCRIPT, type BuildInput, buildJob, CLONE_SCRIPT, DEFAULT_IMAGES, DIGEST_LINE } from "./job.ts";

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
