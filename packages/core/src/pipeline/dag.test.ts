/**
 * Golden cases for DAG evaluation, carried over one for one from the
 * predecessor system's tests so the rebuilt evaluation decides the same way.
 * The fixtures sit on the boundaries where behaviour diverges: skipped mixed
 * with failed, unknown, tag pushes and missing path filters.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateRunStatus,
  anyPathMatches,
  evaluateOn,
  evaluatePaths,
  isRunComplete,
  matchPath,
  nextReadyJobs,
  rootJobs,
  shouldSkipForPaths,
  shouldSkipForUpstream,
} from "./dag.ts";
import type { PipelineDef } from "./definition.ts";

const def = {
  on: {
    push: { branches: ["main", "release/*"], tags: ["v*"] },
    pull_request: { branches: ["main"] },
    schedule: [{ cron: "0 3 * * *" }],
  },
  jobs: {
    build: { pipeline: "C", if: { paths: ["dispatcher/**"] } },
    docs: { pipeline: "N", if: { paths: ["docs/**"] } },
    test: { pipeline: "C", needs: ["build"] },
    deploy: { pipeline: "N", needs: ["build", "test"] },
    always: { pipeline: "W" },
  },
} as PipelineDef;
const jobs = def.jobs as Record<"build" | "docs" | "test" | "deploy" | "always", PipelineDef["jobs"][string]>;

const st = (o: Record<string, string>) => new Map(Object.entries(o));
const asDef = (d: unknown) => d as PipelineDef;

describe("matchPath / anyPathMatches — GitHub Actions glob", () => {
  it("** crosses directories, * does not", () => {
    assert.equal(matchPath("dispatcher/**", "dispatcher/src/index.ts"), true);
    assert.equal(matchPath("dispatcher/*", "dispatcher/src/index.ts"), false);
    assert.equal(matchPath("dispatcher/*", "dispatcher/README.md"), true);
    assert.equal(matchPath("docs/?.md", "docs/a.md"), true);
    assert.equal(matchPath("a.b", "aXb"), false);
  });
  it("no patterns match everything; no paths match nothing", () => {
    assert.equal(anyPathMatches([], ["x"]), true);
    assert.equal(anyPathMatches(["docs/**"], []), false);
    assert.equal(anyPathMatches(["docs/**", "dispatcher/**"], ["dispatcher/a.ts"]), true);
  });
  it("regex metacharacters in a pattern are literal", () => {
    assert.equal(matchPath("a+(b).ts", "a+(b).ts"), true);
    assert.equal(matchPath("a+(b).ts", "aa(b).ts"), false);
  });
});

describe("evaluateOn — triggers", () => {
  it("without on, only a push to the default branch (unlike the predecessor: any branch)", () => {
    const d = asDef({ jobs: {} });
    assert.equal(evaluateOn(d, "push", { branch: "main", defaultBranch: "main" }), true);
    assert.equal(evaluateOn(d, "push", { branch: "feature", defaultBranch: "main" }), false);
    assert.equal(evaluateOn(d, "push", { branch: "main" }), false, "unknown default branch: fail closed");
    assert.equal(evaluateOn(d, "push", { tag: "v1", defaultBranch: "main" }), false);
    assert.equal(evaluateOn(d, "pull_request", { baseBranch: "main", defaultBranch: "main" }), false);
  });
  it("branch globs; a tag push is judged by tags only", () => {
    assert.equal(evaluateOn(def, "push", { branch: "main" }), true);
    assert.equal(evaluateOn(def, "push", { branch: "release/1.2" }), true);
    assert.equal(evaluateOn(def, "push", { branch: "feature" }), false);
    assert.equal(evaluateOn(def, "push", { tag: "v1.0" }), true);
    assert.equal(evaluateOn(def, "push", { tag: "rc1" }), false);
  });
  it("push without branches matches any branch but no tag", () => {
    const d = asDef({ on: { push: {} }, jobs: {} });
    assert.equal(evaluateOn(d, "push", { branch: "any" }), true);
    assert.equal(evaluateOn(d, "push", { tag: "v1" }), false);
  });
  it("pull_request uses the base branch; schedule and dispatch need to be declared", () => {
    assert.equal(evaluateOn(def, "pull_request", { baseBranch: "main" }), true);
    assert.equal(evaluateOn(def, "pull_request", { baseBranch: "dev" }), false);
    assert.equal(evaluateOn(def, "schedule", {}), true);
    assert.equal(evaluateOn(def, "workflow_dispatch", {}), false);
    assert.equal(evaluateOn(asDef({ on: { workflow_dispatch: {} }, jobs: {} }), "workflow_dispatch", {}), true);
    assert.equal(evaluateOn(def, "unknown_event", {}), false);
  });
});

describe("evaluatePaths / rootJobs / shouldSkipForPaths", () => {
  it("only push events are filtered by paths", () => {
    assert.equal(evaluatePaths(jobs.build, "schedule", null), true);
    assert.equal(evaluatePaths(jobs.build, "push", null), false);
    assert.equal(evaluatePaths(jobs.build, "push", ["dispatcher/x.ts"]), true);
  });
  it("roots have no needs and pass their filter", () => {
    assert.deepEqual(rootJobs(def, "push", ["dispatcher/x.ts"]), ["build", "always"]);
    assert.deepEqual(rootJobs(def, "push", ["README.md"]), ["always"]);
    assert.deepEqual(rootJobs(def, "schedule", null), ["build", "docs", "always"]);
  });
  it("a job whose filter fails is skipped", () => {
    assert.equal(shouldSkipForPaths(jobs.docs, "push", ["dispatcher/x.ts"]), true);
    assert.equal(shouldSkipForPaths(jobs.docs, "push", ["docs/a.md"]), false);
  });
});

describe("nextReadyJobs / shouldSkipForUpstream — skipped is not success", () => {
  it("ready means not created and every dependency succeeded", () => {
    assert.deepEqual(nextReadyJobs(def, st({ build: "success", docs: "skipped", always: "success" })), ["test"]);
    assert.deepEqual(nextReadyJobs(def, st({ build: "success", test: "success" })), ["docs", "deploy", "always"]);
    assert.deepEqual(nextReadyJobs(def, st({ build: "running" })), ["docs", "always"]);
  });
  it("a dependency that ended without success skips its dependents; unfinished ones wait", () => {
    assert.deepEqual(shouldSkipForUpstream(def, st({ build: "failed" })), ["test"]);
    assert.deepEqual(shouldSkipForUpstream(def, st({ build: "success", test: "skipped" })), ["deploy"]);
    assert.deepEqual(shouldSkipForUpstream(def, st({ build: "success", test: "running" })), []);
    assert.deepEqual(shouldSkipForUpstream(def, st({ build: "unknown" })), ["test"]);
  });
});

describe("isRunComplete / aggregateRunStatus", () => {
  it("complete only when every job has ended; a job not created is not ended", () => {
    const all = { build: "success", docs: "skipped", test: "success", deploy: "success", always: "success" };
    assert.equal(isRunComplete(def, st(all)), true);
    assert.equal(isRunComplete(def, st({ ...all, test: "running" })), false);
    const { always: _always, ...withoutAlways } = all;
    assert.equal(isRunComplete(def, st(withoutAlways)), false);
  });
  it("failed or unknown → failed; cancelled alone → cancelled; otherwise success", () => {
    const base = { build: "success", docs: "skipped", deploy: "skipped", always: "success" };
    assert.equal(aggregateRunStatus(def, st({ ...base, test: "unknown" })), "failed");
    assert.equal(aggregateRunStatus(def, st({ ...base, test: "cancelled" })), "cancelled");
    assert.equal(aggregateRunStatus(def, st({ build: "failed", test: "cancelled" })), "failed");
    assert.equal(aggregateRunStatus(def, st({ ...base, deploy: "success", test: "success" })), "success");
  });
});
