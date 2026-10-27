import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPipelineDef } from "./definition.ts";
import { planRun } from "./plan.ts";

const def = loadPipelineDef({
  on: { push: { branches: ["main"] } },
  jobs: {
    api: { pipeline: "C", component: "api", if: { paths: ["api/**"] } },
    web: { pipeline: "N", if: { paths: ["web/**"] } },
    migrate: { pipeline: "C", component: "api", needs: ["api"] },
    smoke: { pipeline: "C", component: "api", needs: ["migrate", "web"] },
  },
});

describe("planRun", () => {
  it("runs what the paths ask for, and what depends only on that", () => {
    assert.deepEqual(planRun(def, "push", ["api/main.go"]), { api: "run", migrate: "run", smoke: "skip", web: "skip" });
  });
  it("runs everything downstream when every filter passes", () => {
    assert.deepEqual(planRun(def, "push", ["api/x", "web/y"]), {
      api: "run",
      migrate: "run",
      smoke: "run",
      web: "run",
    });
  });
  it("skips path-filtered jobs when the changed paths are unknown", () => {
    assert.deepEqual(planRun(def, "push", null), { api: "skip", migrate: "skip", smoke: "skip", web: "skip" });
  });
  it("does not filter other events by path", () => {
    assert.deepEqual(planRun(def, "workflow_dispatch", null), { api: "run", migrate: "run", smoke: "run", web: "run" });
  });
});
