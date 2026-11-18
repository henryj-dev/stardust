import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type KubeClient, type KubeResponse, LeaseHandoff } from "@stardust/core";
import { runBuild } from "./executor.ts";

const DIGEST = `sha256:${"e".repeat(64)}`;

/** A fake API server: Job status advances one step per GET. */
function fakeKube(steps: Array<Record<string, unknown>>, log: string, listed: Array<Record<string, unknown>> = []) {
  const calls: string[] = [];
  let gets = 0;
  const kube: KubeClient = {
    async request(method, path): Promise<KubeResponse> {
      calls.push(`${method} ${path.split("?")[0]}`);
      if (method === "GET" && path.includes("/jobs?labelSelector="))
        return { status: 200, body: JSON.stringify({ items: listed }) };
      if (method === "POST") return { status: 201, body: JSON.stringify({ metadata: { name: "build-x-1" } }) };
      if (method === "DELETE") return { status: 200, body: "{}" };
      if (path.includes("/pods?"))
        return { status: 200, body: JSON.stringify({ items: [{ metadata: { name: "pod-1" } }] }) };
      if (path.includes("/log")) return { status: 200, body: log };
      const status = steps[Math.min(gets++, steps.length - 1)];
      return { status: 200, body: JSON.stringify({ metadata: { name: "build-x-1" }, status }) };
    },
  };
  return { kube, calls };
}
const run = (kube: KubeClient, signal = new AbortController().signal) =>
  runBuild(kube, "builds", { kind: "Job" }, { signal, pollMs: 1 });

describe("runBuild", () => {
  it("waits for success and returns the digest from the build log", async () => {
    const { kube, calls } = fakeKube(
      [{}, { active: 1 }, { succeeded: 1 }],
      `[build] x\n[stardust-image-digest] ${DIGEST}\n`,
    );
    const outcome = await run(kube);
    assert.equal(outcome.result, "success");
    assert.equal(outcome.digest, DIGEST);
    assert.equal(outcome.jobName, "build-x-1");
    assert.equal(calls[0], "POST /apis/batch/v1/namespaces/builds/jobs");
    assert.ok(calls.includes("GET /api/v1/namespaces/builds/pods/pod-1/log"));
  });
  it("a success without a digest is a failure", async () => {
    const { kube } = fakeKube([{ succeeded: 1 }], "[build] pushed\n");
    const outcome = await run(kube);
    assert.equal(outcome.result, "failed");
    assert.match(outcome.reason ?? "", /no image digest/);
  });
  it("reports the failure reason of a failed Job", async () => {
    const { kube } = fakeKube(
      [{ failed: 1, conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] }],
      "",
    );
    const outcome = await run(kube);
    assert.equal(outcome.result, "failed");
    assert.equal(outcome.reason, "DeadlineExceeded");
  });
  it("deletes the Job when cancelled", async () => {
    const { kube, calls } = fakeKube([{ active: 1 }], "");
    const stop = new AbortController();
    stop.abort();
    const outcome = await run(kube, stop.signal);
    assert.equal(outcome.result, "cancelled");
    assert.ok(calls.includes("DELETE /apis/batch/v1/namespaces/builds/jobs/build-x-1"));
  });
  it("surfaces an API error instead of waiting forever", async () => {
    const kube: KubeClient = { request: async () => ({ status: 403, body: "forbidden" }) };
    await assert.rejects(run(kube), /returned 403/);
  });
});

describe("runBuild takes over a Job an earlier attempt left", () => {
  const labelled = { kind: "Job", metadata: { labels: { "stardust/run": "r1", "stardust/job": "build" } } };
  const runLabelled = (kube: KubeClient, signal = new AbortController().signal, afterCreate?: () => Promise<void>) =>
    runBuild(kube, "builds", labelled, { signal, pollMs: 1, ...(afterCreate ? { afterCreate } : {}) });

  it("watches the running Job instead of building again, and reads its digest", async () => {
    const { kube, calls } = fakeKube([{ succeeded: 1 }], `[stardust-image-digest] ${DIGEST}\n`, [
      { metadata: { name: "build-old", creationTimestamp: "2026-01-01T00:00:00Z" } },
      { metadata: { name: "build-older", creationTimestamp: "2025-12-31T00:00:00Z" } },
    ]);
    let released = false;
    const outcome = await runLabelled(kube, undefined, async () => {
      released = true;
    });
    assert.equal(outcome.result, "success");
    assert.equal(outcome.digest, DIGEST);
    assert.equal(outcome.jobName, "build-old", "the newest of them");
    assert.ok(!calls.some((c) => c.startsWith("POST")), "no second build");
    assert.equal(released, false, "an adopted Job is not released again");
    assert.ok(calls.includes("GET /apis/batch/v1/namespaces/builds/jobs/build-old"));
  });

  it("deletes a suspended leftover and one being deleted is ignored, then builds", async () => {
    const { kube, calls } = fakeKube([{ succeeded: 1 }], `[stardust-image-digest] ${DIGEST}\n`, [
      { metadata: { name: "build-stuck" }, spec: { suspend: true } },
      { metadata: { name: "build-going", deletionTimestamp: "2026-01-01T00:00:00Z" } },
    ]);
    const outcome = await runLabelled(kube);
    assert.equal(outcome.jobName, "build-x-1");
    assert.ok(calls.includes("DELETE /apis/batch/v1/namespaces/builds/jobs/build-stuck"));
    assert.ok(!calls.includes("DELETE /apis/batch/v1/namespaces/builds/jobs/build-going"));
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
  });

  it("leaves the Job running when the job is handed to another worker", async () => {
    const { kube, calls } = fakeKube([{ active: 1 }], "");
    const stop = new AbortController();
    stop.abort(new LeaseHandoff());
    const outcome = await run(kube, stop.signal);
    assert.equal(outcome.result, "cancelled");
    assert.equal(outcome.reason, "handed off");
    assert.ok(!calls.some((c) => c.startsWith("DELETE")), "the Job is the next worker's");
  });
});
