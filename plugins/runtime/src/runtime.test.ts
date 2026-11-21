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
    if (path === "/api/v1/namespaces/demo/services/api")
      return {
        status: 200,
        body: JSON.stringify({
          spec: { type: "LoadBalancer", ports: [{ port: 8788, protocol: "TCP" }] },
          status: { loadBalancer: { ingress: [{ ip: "10.0.0.9" }] } },
        }),
      };
    return { status: 404, body: "" };
  },
  stream: () => Promise.reject(new Error("unused")),
};

const asks: Array<{ kind: string; namespace: string; pod: string; follow: boolean }> = [];
const source = (kind: "live" | "history") => ({
  kind,
  async read(r: { namespace: string; pod: string; follow: boolean }) {
    asks.push({ kind, namespace: r.namespace, pod: r.pod, follow: r.follow });
    if (r.pod === "api-old-1" && kind === "live") return { state: "none" as const };
    return {
      state: "open" as const,
      body: (async function* () {
        yield new TextEncoder().encode(`${kind} line\n`);
      })(),
    };
  },
});

function setup(withLogs = true, config: Record<string, unknown> = {}) {
  const repo = new MemoryRepo({
    [`${DIR}/deployment.yaml`]: DEPLOYMENT,
    [`${DIR}/service.yaml`]:
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  type: LoadBalancer\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api-internal\n",
    [`${DIR}/kustomization.yaml`]: "namespace: demo\nresources:\n  - deployment.yaml\n  - service.yaml\n",
  });
  const projects = {
    get: async (id: string) =>
      id === "demo" ? { id, name: "Demo", githubRepo: null, components: [{ name: "api", deployDir: DIR }] } : null,
  };
  const logs = withLogs ? { kube: source("live"), loki: source("history") } : undefined;
  const [feature] = buildFeatures(
    [plugin],
    { runtime: config },
    { kube, deployRepo: { repo }, projects, ...(logs ? { logs } : {}) },
    quiet,
    "test",
  );
  const route = (method: string, path: string) => {
    const found = feature?.routes.find((r) => r.method === method && r.path === path);
    if (!found) throw new Error(`no route ${method} ${path}`);
    return found as Route;
  };
  const call = (r: Route, params: Record<string, string>, body: unknown = null, query = "") =>
    r.handle({
      params,
      query: new URLSearchParams(query),
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

  it("shows the component's Services with the external address a LoadBalancer got", async () => {
    const { route, call } = setup();
    const res = await call(route("GET", "/projects/:project/components/:component"), params);
    assert.deepEqual((res.body as { services: unknown }).services, [
      {
        name: "api",
        namespace: "demo",
        type: "LoadBalancer",
        ports: [{ port: 8788, protocol: "TCP" }],
        external: "10.0.0.9",
      },
      { name: "api-internal", namespace: "demo", error: "not applied yet" },
    ]);
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

  it("streams a pod's log only for this component's pods, live or kept", async () => {
    const { route, call } = setup();
    const log = route("GET", "/projects/:project/components/:component/pods/:pod/log");
    const read = async (pod: string, query = "") => {
      const res = await call(log, { ...params, pod }, null, query);
      if (!res.stream) return res.status;
      let text = "";
      for await (const chunk of res.stream) text += new TextDecoder().decode(chunk);
      return text;
    };
    asks.length = 0;
    assert.equal(await read("api-7d9-abc", "follow=true"), "live line\n");
    assert.deepEqual(asks[0], { kind: "live", namespace: "demo", pod: "api-7d9-abc", follow: true });
    assert.equal(await read("other-1"), 404, "a pod of another workload is refused before any log is read");
    assert.equal(await read("api-gone-1", "source=history&follow=true"), "history line\n");
    assert.equal(asks.at(-1)?.follow, false, "a kept log is not followed");
    assert.equal(await read("web-1", "source=history"), 404);
    assert.equal(asks.length, 2);
  });

  it("says which log source is missing", async () => {
    const { route, call } = setup(false);
    const res = await call(route("GET", "/projects/:project/components/:component/pods/:pod/log"), {
      ...params,
      pod: "api-7d9-abc",
    });
    assert.equal(res.status, 404);
    assert.match((res.body as { error: string }).error, /no live log source is enabled/);
  });

  it("reads and sets the workload settings in one commit, audited by field", async () => {
    const { repo, route, call } = setup();
    const get = route("GET", "/projects/:project/components/:component/workload");
    const put = route("PUT", "/projects/:project/components/:component/workload");
    const before = (await call(get, params)).body as { settings: { serviceAccount: boolean }; podSecurity: string[] };
    assert.equal(before.settings.serviceAccount, false);
    assert.ok(
      before.podSecurity.some((p) => /runAsNonRoot/.test(p)),
      "the test Deployment says nothing of it",
    );
    const res = await call(put, params, {
      serviceAccount: true,
      runAsUser: 1000,
      probes: { readiness: { path: "/readyz", port: 8080 } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(repo.commitCount(), 1, "the account, the Deployment and the list in one commit");
    const files = repo.files();
    assert.match(files[`${DIR}/stardust-serviceaccount.yaml`] ?? "", /namespace: demo/);
    assert.match(files[`${DIR}/kustomization.yaml`] ?? "", /- stardust-serviceaccount.yaml/);
    assert.match(files[`${DIR}/deployment.yaml`] ?? "", /serviceAccountName: api/);
    assert.equal(res.audit?.target, "api");
    assert.deepEqual(Object.keys(res.audit?.detail ?? {}).sort(), ["probes", "runAsUser", "serviceAccount"]);
    const again = await call(put, params, { serviceAccount: true });
    assert.equal((again.body as { status: string }).status, "up-to-date");
    assert.equal((await call(put, params, { runAsUser: 0 })).status, 400);
    assert.equal((await call(put, params, {})).status, 400);
    assert.equal((await call(put, { ...params, component: "nope" }, { runAsUser: 1 })).status, 404);
    assert.equal(repo.commitCount(), 1);
  });

  it("binds only allowed cluster roles, only to the component's own account, as an administrator", async () => {
    const { repo, route, call } = setup(true, { allowedClusterRoles: ["system:auth-delegator"] });
    const put = route("PUT", "/projects/:project/components/:component/cluster-roles");
    assert.equal(put.permission, "runtime:cluster-roles");
    assert.equal(plugin.permissions?.find((p) => p.id === put.permission)?.grantedTo, "admins");
    assert.equal(put.audit, "runtime.cluster-roles");
    const refused = await call(put, params, { roles: ["cluster-admin"] });
    assert.equal(refused.status, 400);
    assert.match((refused.body as { error: string }).error, /not in runtime.allowedClusterRoles/);
    const noAccount = await call(put, params, { roles: ["system:auth-delegator"] });
    assert.equal(noAccount.status, 400, "the component's own account comes first");
    assert.equal(repo.commitCount(), 0);
    await call(route("PUT", "/projects/:project/components/:component/workload"), params, { serviceAccount: true });
    const bound = await call(put, params, { roles: ["system:auth-delegator"] });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.deepEqual(bound.audit?.detail, { roles: ["system:auth-delegator"] });
    assert.match(repo.files()[`${DIR}/kustomization.yaml`] ?? "", /- stardust-cluster-roles.yaml/);
    const view = await call(route("GET", "/projects/:project/components/:component/cluster-roles"), params);
    assert.deepEqual(view.body, {
      allowed: ["system:auth-delegator"],
      roles: ["system:auth-delegator"],
      serviceAccount: true,
      namespace: "demo",
    });
  });

  it("needs the Kubernetes API, the deploy repository and the projects", () => {
    assert.deepEqual(plugin.requires, ["kube", "deployRepo", "projects"]);
    assert.deepEqual(plugin.validateConfig({ extra: 1 }), ['unknown key "extra"']);
    assert.deepEqual(plugin.validateConfig({ allowedClusterRoles: ["system:auth-delegator"] }), []);
    assert.equal(plugin.validateConfig({ allowedClusterRoles: ["Not A Role"] }).length, 1);
    const external = {
      clusterIPs: "10.0.0.0/24",
      addresses: "10.0.8.0/24",
      addressAnnotation: "lbipam.cilium.io/ips",
    };
    assert.deepEqual(plugin.validateConfig({ external }), []);
    assert.deepEqual(plugin.validateConfig({ external: { ...external, addresses: "10.0.8.0/25" } }), [
      "external: clusterIPs and addresses must be blocks of one size: N is the same offset in each",
    ]);
  });
});
