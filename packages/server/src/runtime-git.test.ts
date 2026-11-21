/**
 * The runtime plugin's component settings against a real Git deploy
 * repository (GitCliRepo and a bare remote), with a person editing the same
 * directory by hand: what stardust does not manage is kept, and each save is
 * one commit.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  addressPolicyProblems,
  buildFeatures,
  type KubeStreamClient,
  type Logger,
  type Route,
  restrictedProblems,
} from "@stardust/core";
import { GitCliRepo } from "@stardust/plugin-gitops-git";
import { plugin } from "@stardust/plugin-runtime";
import { parse, stringify } from "yaml";
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
  return (method: string, path: string, body: unknown = null, params: Record<string, string> = {}) =>
    route(method, path).handle({
      params: { project: "app", component: "server", ...params },
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

describe("secret files in a Git deploy repository", () => {
  // Like SOPS: values under data sealed, keys in clear.
  const seal = (v: string) => `ENC[${Buffer.from(v).toString("hex")}]`;
  const cipher = {
    async decrypt(document: string) {
      const { sops: _s, ...doc } = parse(document) as { sops?: unknown; data?: Record<string, string> };
      const data = Object.fromEntries(
        Object.entries(doc.data ?? {}).map(([k, v]) => [k, Buffer.from(v.slice(4, -1), "hex").toString()]),
      );
      return stringify({ ...doc, data });
    },
    async encryptIfChanged(_current: string | null, plain: string) {
      const doc = parse(plain) as { data?: Record<string, string> };
      const data = Object.fromEntries(Object.entries(doc.data ?? {}).map(([k, v]) => [k, seal(v)]));
      return { changed: true, document: stringify({ ...doc, data, sops: { version: "fake" } }) };
    },
    revisionKey: "k",
  };
  const call = runtimeFeature({}, { cipher });
  const key = "/projects/:project/components/:component/secret-files/:set/keys/:key";
  const params = { set: "kek", key: "key" };

  it("commits a generated key sealed, mounted and listed, as one commit", async () => {
    const before = fixture.head();
    const res = await call("POST", key, { generate: { bytes: 32 } }, params);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(fixture.head(), before);
    const sealed = parse(fixture.read(`${DIR}/secret-files-kek.secret.enc.yaml`) ?? "");
    assert.match(sealed.data.key, /^ENC\[/);
    assert.equal(sealed.metadata.namespace, "app");
    const deployment = fixture.read(`${DIR}/deployment.yaml`) ?? "";
    assert.deepEqual(restrictedProblems(deployment), []);
    assert.match(deployment, /mountPath: \/run\/secrets\/kek/);
    assert.match(fixture.read(`${DIR}/kustomization.yaml`) ?? "", /- secret-files-kek.secret.enc.yaml/);
    const again = await call("POST", key, { generate: { bytes: 32 } }, params);
    assert.equal(again.status, 409, "an existing key is not overwritten by adding it");
    assert.equal((await call("DELETE", key, null, params)).status, 200);
    assert.equal(fixture.read(`${DIR}/secret-files-kek.secret.enc.yaml`), null);
    assert.doesNotMatch(fixture.read(`${DIR}/kustomization.yaml`) ?? "", /secret-files/);
  });
});

describe("a component's address outside the cluster, in a Git deploy repository", () => {
  const EXTERNAL = {
    clusterIPs: "10.0.0.0/24",
    addresses: "10.0.8.0/24",
    reserved: [],
    first: 10,
    last: 20,
    addressAnnotation: "lbipam.cilium.io/ips",
    annotations: { "service.cilium.io/forwarding-mode": "dsr" },
  };
  const inCluster = new Set<string>();
  const clusterKube: KubeStreamClient = {
    async request(_m, p) {
      if (p === "/api/v1/services") return { status: 403, body: "{}" };
      const one = /^\/api\/v1\/namespaces\/([^/]+)\/services\/([^/]+)$/.exec(p);
      if (one) return { status: inCluster.has(`${one[1]}/${one[2]}`) ? 200 : 404, body: "{}" };
      return { status: 404, body: "{}" };
    },
    stream: () => Promise.reject(new Error("unused")),
  };
  // The databases plugin recorded .11 for an instance whose Service this repository does not show.
  const database = {
    async query(text: string) {
      if (text.includes("to_regclass")) return [{ t: "databases_instances" }];
      return [{ a: "10.0.8.11", c: "10.0.0.11" }];
    },
    async transaction<R>(work: (tx: never) => Promise<R>) {
      return work(this as never);
    },
  };
  const call = runtimeFeature({ external: EXTERNAL }, { kube: clusterKube, database });
  const path = "/projects/:project/components/:component/address";
  const vip = `${DIR}/stardust-address.service.yaml`;
  const other = (name: string, n: number) =>
    [
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      `  name: ${name}`,
      "  namespace: app",
      "  annotations:",
      `    lbipam.cilium.io/ips: 10.0.8.${n}`,
      "spec:",
      "  type: LoadBalancer",
      `  clusterIP: 10.0.0.${n}`,
      "",
    ].join("\n");

  it("takes the first N nothing holds: not another app's Service elsewhere, not a database's record", async () => {
    // Another app's address, in a directory far from the component's.
    fixture.push({ "clusters/one/infra/edge/vip.yaml": other("edge-vip", 10) });
    const before = fixture.head();
    const res = await call("POST", path, { ports: [{ port: 8080, targetPort: 8080 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(fixture.head(), before);
    const svc = parse(fixture.read(vip) ?? "");
    assert.equal(svc.metadata.name, "server-vip");
    assert.equal(svc.spec.clusterIP, "10.0.0.12", ".10 the other app, .11 the database");
    assert.equal(svc.metadata.annotations["lbipam.cilium.io/ips"], "10.0.8.12");
    assert.deepEqual(addressPolicyProblems(svc, EXTERNAL), []);
    assert.match(fixture.read(`${DIR}/kustomization.yaml`) ?? "", /- stardust-address.service.yaml/);
    const view = (await call("GET", path)).body as { address: { address: string; problems: string[] } };
    assert.deepEqual([view.address.address, view.address.problems], ["10.0.8.12", []]);
  });

  it("changes only the ports: the same name, cluster IP and address", async () => {
    const before = parse(fixture.read(vip) ?? "");
    const res = await call("PUT", `${path}/ports`, { ports: [{ port: 443, targetPort: 8443 }, { port: 9000 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as { status: string }).status, "committed");
    const after = parse(fixture.read(vip) ?? "");
    assert.equal(after.spec.clusterIP, before.spec.clusterIP);
    assert.equal(
      after.metadata.annotations["lbipam.cilium.io/ips"],
      before.metadata.annotations["lbipam.cilium.io/ips"],
    );
    assert.deepEqual(
      after.spec.ports.map((p: { port: number; targetPort: number }) => [p.port, p.targetPort]),
      [
        [443, 8443],
        [9000, 9000],
      ],
    );
    assert.deepEqual(addressPolicyProblems(after, EXTERNAL), [], "still the shape the policy admits");
    const again = await call("PUT", `${path}/ports`, { ports: [{ port: 443, targetPort: 8443 }, { port: 9000 }] });
    assert.equal((again.body as { status: string }).status, "up-to-date");
    const head = fixture.head();
    const twice = await call("PUT", `${path}/ports`, { ports: [{ port: 443 }, { port: 443, targetPort: 8443 }] });
    assert.equal(twice.status, 400);
    assert.match((twice.body as { error: string }).error, /port 443 is given twice/);
    assert.equal(fixture.head(), head, "nothing pushed");
  });

  it("does not give a second address, and removes the one it gave", async () => {
    assert.equal((await call("POST", path, { ports: [{ port: 8080 }] })).status, 409);
    assert.equal((await call("DELETE", path)).status, 200);
    assert.equal(fixture.read(vip), null);
    assert.doesNotMatch(fixture.read(`${DIR}/kustomization.yaml`) ?? "", /stardust-address/);
  });

  it("has no ports to change without an address", async () => {
    assert.equal((await call("PUT", `${path}/ports`, { ports: [{ port: 8080 }] })).status, 404);
  });

  it("refuses a name another file in the repository declares, and pushes nothing", async () => {
    fixture.push({ "clusters/one/apps/app/old/vip.yaml": other("server-vip", 14) });
    const before = fixture.head();
    const res = await call("POST", path, { ports: [{ port: 8080 }] });
    assert.equal(res.status, 409);
    assert.match((res.body as { error: string }).error, /old\/vip.yaml declares a Service app\/server-vip/);
    assert.equal(fixture.head(), before, "nothing pushed");
    fixture.push({ "clusters/one/apps/app/old/vip.yaml": null });
  });

  it("refuses a name the cluster has already, and pushes nothing", async () => {
    inCluster.add("app/server-vip");
    const before = fixture.head();
    const res = await call("POST", path, { ports: [{ port: 8080 }] });
    assert.equal(res.status, 409);
    assert.match((res.body as { error: string }).error, /the cluster has a Service app\/server-vip/);
    assert.equal(fixture.head(), before, "nothing pushed");
    inCluster.delete("app/server-vip");
  });
});
