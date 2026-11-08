import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubeStreamClient } from "./kube.ts";
import { buildLogReader } from "./logs.ts";

const RUN = "8ee4cd25-dd58-4701-8e08-1e5f5265d22d";
type Pod = { name: string; created: string; build?: "waiting" | "running" | "terminated" };

function fakeKube(pods: Pod[], log: { status: number; chunks: string[] } = { status: 200, chunks: ["a\n", "b\n"] }) {
  const calls: string[] = [];
  const kube: KubeStreamClient = {
    async request(method, path) {
      calls.push(`${method} ${decodeURIComponent(path)}`);
      const items = pods.map((p) => ({
        metadata: { name: p.name, creationTimestamp: p.created },
        status: p.build ? { containerStatuses: [{ name: "build", state: { [p.build]: {} } }] } : {},
      }));
      return { status: 200, body: JSON.stringify({ items }) };
    },
    async stream(path) {
      calls.push(`STREAM ${decodeURIComponent(path)}`);
      return {
        status: log.status,
        body: (async function* () {
          for (const c of log.chunks) yield new TextEncoder().encode(c);
        })(),
      };
    },
  };
  return { kube, calls };
}
const read = (kube: KubeStreamClient, jobName = "web", follow = true) =>
  buildLogReader(kube, "builds", { tailLines: 10, limitBytes: 100 })({
    runId: RUN,
    jobName,
    follow,
    signal: new AbortController().signal,
  });
const text = async (body: AsyncIterable<Uint8Array>) => {
  let out = "";
  for await (const c of body) out += new TextDecoder().decode(c);
  return out;
};

describe("buildLogReader", () => {
  it("finds the pod by run and job labels and streams the build container", async () => {
    const { kube, calls } = fakeKube([{ name: "p1", created: "2026-01-01T00:00:00Z", build: "running" }]);
    const log = await read(kube);
    assert.equal(log.state, "open");
    if (log.state !== "open") return;
    assert.equal(log.pod, "p1");
    assert.equal(await text(log.body), "a\nb\n");
    assert.equal(calls[0], `GET /api/v1/namespaces/builds/pods?labelSelector=stardust/run=${RUN},stardust/job=web`);
    assert.equal(
      calls[1],
      "STREAM /api/v1/namespaces/builds/pods/p1/log?container=build&follow=true&tailLines=10&limitBytes=100",
    );
  });
  it("reads the newest attempt's pod, and a finished one without following", async () => {
    const { kube, calls } = fakeKube([
      { name: "old", created: "2026-01-01T00:00:00Z", build: "terminated" },
      { name: "new", created: "2026-01-01T00:05:00Z", build: "terminated" },
    ]);
    const log = await read(kube, "web", false);
    assert.equal(log.state === "open" && log.pod, "new");
    assert.match(calls[1] ?? "", /pods\/new\/log\?container=build&follow=false/);
  });
  it("no pod is none; a build container not started yet is waiting", async () => {
    assert.deepEqual(await read(fakeKube([]).kube), { state: "none" });
    assert.deepEqual(await read(fakeKube([{ name: "p", created: "x" }]).kube), { state: "waiting" });
    assert.deepEqual(await read(fakeKube([{ name: "p", created: "x", build: "waiting" }]).kube), {
      state: "waiting",
    });
    const between = fakeKube([{ name: "p", created: "x", build: "running" }], { status: 400, chunks: ["{}"] });
    assert.deepEqual(await read(between.kube), { state: "waiting" });
  });
  it("a job name that is not a label value asks Kubernetes nothing", async () => {
    const { kube, calls } = fakeKube([{ name: "p", created: "x", build: "running" }]);
    assert.deepEqual(await read(kube, "web,stardust/run!=x"), { state: "none" });
    assert.deepEqual(calls, []);
  });
  it("an API error is an error, not an empty log", async () => {
    const { kube } = fakeKube([{ name: "p", created: "x", build: "running" }], { status: 403, chunks: ["denied"] });
    await assert.rejects(read(kube), /returned 403/);
  });
});
