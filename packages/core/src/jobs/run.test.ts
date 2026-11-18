import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubeClient, KubeResponse } from "../ports/kube.ts";
import { LeaseHandoff, runJob } from "./run.ts";

function fakeKube(listed: Array<Record<string, unknown>>, status: Record<string, unknown>) {
  const calls: string[] = [];
  const kube: KubeClient = {
    async request(method, path): Promise<KubeResponse> {
      calls.push(`${method} ${path.split("?")[0]}`);
      if (method === "GET" && path.includes("/jobs?labelSelector="))
        return { status: 200, body: JSON.stringify({ items: listed }) };
      if (method === "POST") return { status: 201, body: JSON.stringify({ metadata: { name: "deploy-new" } }) };
      if (method === "DELETE") return { status: 200, body: "{}" };
      if (path.includes("/pods?")) return { status: 200, body: JSON.stringify({ items: [] }) };
      return { status: 200, body: JSON.stringify({ status }) };
    },
  };
  return { kube, calls };
}
const manifest = { kind: "Job", metadata: { labels: { "stardust/run": "r1", "stardust/job": "deploy" } } };

describe("runJob", () => {
  it("takes over the Job an earlier attempt of the same job left, instead of running it again", async () => {
    const { kube, calls } = fakeKube([{ metadata: { name: "deploy-old" } }], { succeeded: 1 });
    const run = await runJob(kube, "ns", manifest, { signal: new AbortController().signal, pollMs: 1 });
    assert.equal(run.result, "success");
    assert.equal(run.jobName, "deploy-old");
    assert.ok(!calls.some((c) => c.startsWith("POST")));
  });

  it("creates the Job when there is none to take over", async () => {
    const { kube, calls } = fakeKube([], { succeeded: 1 });
    const run = await runJob(kube, "ns", manifest, { signal: new AbortController().signal, pollMs: 1 });
    assert.equal(run.jobName, "deploy-new");
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
  });

  it("deletes the Job on a cancellation but not on a hand-off", async () => {
    for (const [reason, deletes] of [
      [new Error("cancelled"), true],
      [new LeaseHandoff(), false],
    ] as const) {
      const { kube, calls } = fakeKube([], { active: 1 });
      const stop = new AbortController();
      stop.abort(reason);
      const run = await runJob(kube, "ns", manifest, { signal: stop.signal, pollMs: 1 });
      assert.equal(run.result, "cancelled");
      assert.equal(
        calls.some((c) => c.startsWith("DELETE")),
        deletes,
        String(reason),
      );
    }
  });
});
