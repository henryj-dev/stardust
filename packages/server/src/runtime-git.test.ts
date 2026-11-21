/**
 * The runtime plugin's component settings against a real Git deploy
 * repository (GitCliRepo and a bare remote), with a person editing the same
 * directory by hand: what stardust does not manage is kept, and each save is
 * one commit.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildFeatures, type KubeStreamClient, type Logger, type Route, restrictedProblems } from "@stardust/core";
import { GitCliRepo } from "@stardust/plugin-gitops-git";
import { plugin } from "@stardust/plugin-runtime";
import { parse } from "yaml";
import { gitFixture } from "./git-testing.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DIR = "clusters/one/apps/app/server";
const DEPLOYMENT = `# written by hand; this comment stays
apiVersion: apps/v1
kind: Deployment
metadata:
  name: server
  namespace: app
spec:
  replicas: 1
  selector:
    matchLabels: { app: server }
  template:
    metadata:
      labels: { app: server }
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: server
          image: registry.example.com/app/server:1
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
`;

const fixture = gitFixture({
  [`${DIR}/deployment.yaml`]: DEPLOYMENT,
  [`${DIR}/kustomization.yaml`]: "# listed by hand\nresources:\n- deployment.yaml\n",
});
after(() => fixture.cleanup());

const kube: KubeStreamClient = {
  async request() {
    return { status: 404, body: "{}" };
  },
  stream: () => Promise.reject(new Error("unused")),
};

function runtimeFeature(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const repo = new GitCliRepo({ url: fixture.remote, branch: "main" });
  const projects = {
    get: async (id: string) =>
      id === "app" ? { id, name: "App", githubRepo: null, components: [{ name: "server", deployDir: DIR }] } : null,
  };
  const [feature] = buildFeatures(
    [plugin],
    { runtime: config },
    { kube, deployRepo: { repo }, projects, ...extra },
    quiet,
    "test",
  );
  const route = (method: string, path: string) => {
    const r = feature?.routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r as Route;
  };
  return (method: string, path: string, body: unknown = null) =>
    route(method, path).handle({
      params: { project: "app", component: "server" },
      query: new URLSearchParams(),
      body,
      user: { id: "u", username: "admin", isAdmin: true },
      signal: new AbortController().signal,
    });
}

describe("workload settings in a Git deploy repository", () => {
  const call = runtimeFeature();
  const path = "/projects/:project/components/:component/workload";

  it("commits the settings, the account and its list entry as one commit, keeping the hand-written parts", async () => {
    const before = fixture.head();
    const res = await call("PUT", path, {
      serviceAccount: true,
      probes: { startup: { path: "/healthz", port: 8080 }, readiness: { path: "/readyz", port: 8080 } },
      readOnlyRootFilesystem: true,
      writablePaths: ["/tmp"],
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      oneAtATime: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = fixture.head();
    assert.notEqual(after, before);
    const deployment = fixture.read(`${DIR}/deployment.yaml`) ?? "";
    assert.ok(deployment.startsWith("# written by hand; this comment stays"), deployment);
    assert.deepEqual(restrictedProblems(deployment), []);
    assert.equal(parse(deployment).spec.template.spec.serviceAccountName, "server");
    assert.equal(parse(fixture.read(`${DIR}/stardust-serviceaccount.yaml`) ?? "").kind, "ServiceAccount");
    const listing = fixture.read(`${DIR}/kustomization.yaml`) ?? "";
    assert.equal(listing, "# listed by hand\nresources:\n- deployment.yaml\n- stardust-serviceaccount.yaml");
  });

  it("builds on what was pushed by hand in between, and reads the result back", async () => {
    fixture.push({
      [`${DIR}/deployment.yaml`]: (fixture.read(`${DIR}/deployment.yaml`) ?? "").replace(
        "replicas: 1",
        "replicas: 1 # by hand",
      ),
    });
    const res = await call("PUT", path, { probes: { liveness: { path: "/healthz", port: 8080 } } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const deployment = fixture.read(`${DIR}/deployment.yaml`) ?? "";
    assert.match(deployment, /replicas: 1 # by hand/);
    assert.match(deployment, /livenessProbe:/);
    const view = await call("GET", path);
    const s = (view.body as { settings: { serviceAccount: boolean; writablePaths: string[]; oneAtATime: boolean } })
      .settings;
    assert.deepEqual([s.serviceAccount, s.writablePaths, s.oneAtATime], [true, ["/tmp"], true]);
  });
});

describe("cluster roles in a Git deploy repository", () => {
  const call = runtimeFeature({ allowedClusterRoles: ["system:auth-delegator"] });
  const path = "/projects/:project/components/:component/cluster-roles";

  it("commits the binding with its list entry, refuses a role not allowed, and pushes nothing then", async () => {
    const before = fixture.head();
    assert.equal((await call("PUT", path, { roles: ["cluster-admin"] })).status, 400);
    assert.equal(fixture.head(), before, "nothing pushed");
    const res = await call("PUT", path, { roles: ["system:auth-delegator"] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const crb = parse(fixture.read(`${DIR}/stardust-cluster-roles.yaml`) ?? "");
    assert.deepEqual(crb.subjects, [{ kind: "ServiceAccount", name: "server", namespace: "app" }]);
    assert.match(fixture.read(`${DIR}/kustomization.yaml`) ?? "", /- stardust-cluster-roles.yaml/);
    const off = await call("PUT", "/projects/:project/components/:component/workload", { serviceAccount: false });
    assert.equal(off.status, 400, "the account stays while a role is bound to it");
    assert.equal((await call("PUT", path, { roles: [] })).status, 200);
    assert.equal(fixture.read(`${DIR}/stardust-cluster-roles.yaml`), null);
    assert.doesNotMatch(fixture.read(`${DIR}/kustomization.yaml`) ?? "", /stardust-cluster-roles/);
  });
});
