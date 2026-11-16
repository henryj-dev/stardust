import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFeatures, type KubeStreamClient, type Logger, type Route } from "@stardust/core";
import { MemoryRepo } from "@stardust/core/testing";
import { plugin, RESTART_ANNOTATION } from "./index.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DIR = "deploy/demo/api";
const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: registry.example.com/demo/api:1
`;

const asked: string[] = [];
const kube: KubeStreamClient = {
  async request(_method, path) {
    asked.push(path);
    if (path === "/apis/apps/v1/namespaces/demo/deployments/api")
      return {
        status: 200,
        body: JSON.stringify({
          spec: { replicas: 2 },
          status: { readyReplicas: 1, updatedReplicas: 2, availableReplicas: 1 },
        }),
      };
    if (path.startsWith("/api/v1/namespaces/demo/pods?"))
      return {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              metadata: { name: "api-7d9-abc" },
              spec: { nodeName: "node-a" },
              status: {
                phase: "Running",
                conditions: [{ type: "Ready", status: "False" }],
                containerStatuses: [
                  { name: "api", ready: false, restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } },
                ],
              },
            },
          ],
        }),
      };
    if (path.startsWith("/api/v1/namespaces/demo/events"))
      return {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              type: "Warning",
              reason: "BackOff",
              message: "Back-off restarting",
              involvedObject: { kind: "Pod", name: "api-7d9-abc" },
              lastTimestamp: "2026-11-15T01:00:00Z",
            },
            {
              type: "Normal",
              reason: "ScalingReplicaSet",
              involvedObject: { kind: "Deployment", name: "api" },
              lastTimestamp: "2026-11-15T00:00:00Z",
            },
            {
              type: "Normal",
              reason: "Pulled",
              involvedObject: { kind: "Pod", name: "other-1" },
              lastTimestamp: "2026-11-15T02:00:00Z",
            },
          ],
        }),
      };
    return { status: 404, body: "" };
  },
  stream: () => Promise.reject(new Error("unused")),
};

function setup() {
  const repo = new MemoryRepo({
    [`${DIR}/deployment.yaml`]: DEPLOYMENT,
    [`${DIR}/kustomization.yaml`]: "namespace: demo\nresources:\n  - deployment.yaml\n",
  });
  const projects = {
    get: async (id: string) =>
      id === "demo" ? { id, name: "Demo", githubRepo: null, components: [{ name: "api", deployDir: DIR }] } : null,
  };
  const [feature] = buildFeatures([plugin], { runtime: {} }, { kube, deployRepo: { repo }, projects }, quiet, "test");
  const route = (method: string, path: string) => {
    const found = feature?.routes.find((r) => r.method === method && r.path === path);
    if (!found) throw new Error(`no route ${method} ${path}`);
    return found as Route;
  };
  const call = (r: Route, params: Record<string, string>, body: unknown = null) =>
    r.handle({
      params,
      query: new URLSearchParams(),
      body,
      user: { id: "u", username: "u", isAdmin: true },
      signal: new AbortController().signal,
    });
  return { repo, route, call, feature };
}
const params = { project: "demo", component: "api" };

describe("runtime", () => {
  it("shows a component's workloads with their pods and only their events, in the kustomization's namespace", async () => {
    const { route, call } = setup();
    const res = await call(route("GET", "/projects/:project/components/:component"), params);
    assert.equal(res.status, 200);
    const [w] = (res.body as { workloads: Array<Record<string, unknown>> }).workloads;
    assert.equal(w?.namespace, "demo");
    assert.deepEqual([w?.desired, w?.ready, w?.available], [2, 1, 1]);
    const pods = w?.pods as Array<{
      name: string;
      restarts: number;
      ready: boolean;
      containers: Array<{ reason: string }>;
    }>;
    assert.deepEqual(
      pods.map((p) => [p.name, p.ready, p.restarts, p.containers[0]?.reason]),
      [["api-7d9-abc", false, 3, "CrashLoopBackOff"]],
    );
    const events = w?.events as Array<{ reason: string }>;
    assert.deepEqual(
      events.map((e) => e.reason),
      ["BackOff", "ScalingReplicaSet"],
      "another pod's event is left out",
    );
    assert.ok(
      asked.some((p) => p.includes(encodeURIComponent("app=api"))),
      "pods are found by the selector",
    );
  });

  it("restarts by committing a new pod-template annotation, so the controller rolls it out", async () => {
    const { repo, route, call } = setup();
    const res = await call(route("POST", "/projects/:project/components/:component/restart"), params);
    assert.equal(res.status, 200);
    assert.equal((res.body as { status: string }).status, "committed");
    assert.equal(res.audit?.target, "api");
    const text = repo.files()[`${DIR}/deployment.yaml`] ?? "";
    assert.ok(text.includes(`${RESTART_ANNOTATION}:`), text);
    assert.equal(repo.commitCount(), 1);
  });

  it("scales and sizes one workload in one commit, and refuses what it cannot do", async () => {
    const { repo, route, call } = setup();
    const scale = route("PUT", "/projects/:project/components/:component/workloads/:kind/:name/replicas");
    const at = { ...params, kind: "Deployment", name: "api" };
    assert.equal((await call(scale, at, { replicas: 4 })).status, 200);
    assert.ok(repo.files()[`${DIR}/deployment.yaml`]?.includes("replicas: 4"));
    const same = await call(scale, at, { replicas: 4 });
    assert.equal((same.body as { status: string }).status, "up-to-date");
    assert.equal(same.audit, undefined, "nothing changed, nothing to audit");
    assert.equal((await call(scale, at, { replicas: -1 })).status, 400);
    assert.equal((await call(scale, at, { replicas: "4" })).status, 400);
    assert.equal((await call(scale, { ...at, name: "web" }, { replicas: 1 })).status, 400);
    assert.equal((await call(scale, { ...at, kind: "Pod" }, { replicas: 1 })).status, 404);
    assert.equal((await call(scale, { ...at, component: "nope" }, { replicas: 1 })).status, 404);

    const size = route("PUT", "/projects/:project/components/:component/workloads/:kind/:name/resources");
    const sized = await call(size, at, { container: "api", limits: { memory: "256Mi" } });
    assert.equal(sized.status, 200);
    assert.ok(repo.files()[`${DIR}/deployment.yaml`]?.includes("memory: 256Mi"));
    assert.deepEqual(sized.audit?.detail, { container: "api", limits: { memory: "256Mi" } });
    assert.equal((await call(size, at, { container: "api", limits: { memory: "lots" } })).status, 400);
    assert.equal(repo.commitCount(), 2);
  });

  it("needs the Kubernetes API, the deploy repository and the projects", () => {
    assert.deepEqual(plugin.requires, ["kube", "deployRepo", "projects"]);
    assert.deepEqual(plugin.validateConfig({ extra: 1 }), ['unknown key "extra"']);
  });
});
