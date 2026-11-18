import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubeStreamClient } from "@stardust/core";
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

  it("reads a Worker release's deploy container, or the init step that runs or failed before it", async () => {
    const release = (deploy: Record<string, unknown> | null, init: Array<[string, Record<string, unknown>]>) => {
      const calls: string[] = [];
      const kube: KubeStreamClient = {
        async request() {
          const item = {
            metadata: { name: "r", creationTimestamp: "x" },
            spec: { containers: [{ name: "deploy" }] },
            status: {
              initContainerStatuses: init.map(([name, state]) => ({ name, state })),
              containerStatuses: deploy ? [{ name: "deploy", state: deploy }] : [],
            },
          };
          return { status: 200, body: JSON.stringify({ items: [item] }) };
        },
        async stream(path) {
          calls.push(decodeURIComponent(path));
          return { status: 200, body: (async function* () {})() };
        },
      };
      return { kube, calls };
    };
    const done = { terminated: { exitCode: 0 } };
    const finished = release(done, [
      ["clone", done],
      ["build", done],
    ]);
    assert.equal((await read(finished.kube, "web", false)).state, "open");
    assert.match(finished.calls[0] ?? "", /container=deploy&/);
    const building = release({ waiting: {} }, [
      ["clone", done],
      ["build", { running: {} }],
    ]);
    await read(building.kube);
    assert.match(building.calls[0] ?? "", /container=build&/);
    const failed = release({ waiting: {} }, [
      ["clone", done],
      ["build", { terminated: { exitCode: 1 } }],
    ]);
    await read(failed.kube, "web", false);
    assert.match(failed.calls[0] ?? "", /container=build&/);
    assert.deepEqual(await read(release(null, [["clone", { waiting: {} }]]).kube), { state: "waiting" });
  });

  it("reads the build container when a state cache made it an init container", async () => {
    const calls: string[] = [];
    const kube: KubeStreamClient = {
      async request() {
        const item = {
          metadata: { name: "b", creationTimestamp: "x" },
          spec: {
            initContainers: [{ name: "clone" }, { name: "cache-restore" }, { name: "build" }],
            containers: [{ name: "cache-save" }],
          },
          status: {
            initContainerStatuses: [
              { name: "clone", state: { terminated: { exitCode: 0 } } },
              { name: "cache-restore", state: { terminated: { exitCode: 0 } } },
              { name: "build", state: { running: {} } },
            ],
            containerStatuses: [{ name: "cache-save", state: { waiting: {} } }],
          },
        };
        return { status: 200, body: JSON.stringify({ items: [item] }) };
      },
      async stream(path) {
        calls.push(decodeURIComponent(path));
        return { status: 200, body: (async function* () {})() };
      },
    };
    assert.equal((await read(kube)).state, "open");
    assert.match(calls[0] ?? "", /container=build&/);
  });
});
