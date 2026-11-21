/**
 * Addresses outside the cluster and the superuser's connection, through the
 * server: a new instance gets its LoadBalancer Service in the same commit,
 * N never lands on an address already held, one written by hand is
 * recognised, and the superuser's password is shown to administrators only,
 * audited, never cached.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildFeatures, createPluginRegistry, type KubeStreamClient, type Logger } from "@stardust/core";
import { MemoryRepo } from "@stardust/core/testing";
import { createUser, databasePort, ensureBootstrapAdmin, listAudit, migratePlugin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { plugin } from "@stardust/plugin-databases";
import { statefulSetPostgres } from "@stardust/plugin-db-statefulset";
import { parse } from "yaml";
import { createApp } from "./app.ts";
import { fakeCodec } from "./env-testing.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let db: TestDb;
let repo: MemoryRepo;
let app: ReturnType<typeof createApp>;
let admin: Record<string, string>;
let member: Record<string, string>;
const codec = fakeCodec();

const EXTERNAL = {
  clusterIPs: "10.0.0.0/24",
  addresses: "10.0.8.0/24",
  reserved: [],
  first: 10,
  last: 20,
  addressAnnotation: "lbipam.cilium.io/ips",
  labels: { "example.com/ip-block": "db" },
  annotations: { "service.cilium.io/forwarding-mode": "dsr" },
};

const legacy = {
  metadata: { namespace: "apps", name: "legacy" },
  spec: {
    replicas: 1,
    serviceName: "legacy",
    selector: { matchLabels: { app: "legacy" } },
    template: {
      spec: {
        containers: [
          {
            image: "postgres:16-alpine",
            env: [{ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "legacy-pw", key: "pw" } } }],
          },
        ],
      },
    },
  },
  status: { readyReplicas: 1 },
};
const plainOld = { ...legacy, metadata: { namespace: "apps", name: "plainold" } };

/** Whether this process may list every Service; the chart does not grant it. */
let mayListServices = true;
/** Whether it may read Services in a namespace (the chart grants it there). */
let mayReadServices = true;
/** Services in the cluster that the deploy repository's root does not hold. */
const inCluster = new Set<string>();
const kube: KubeStreamClient = {
  async stream() {
    throw new Error("not used");
  },
  async request(_m, path) {
    if (path === "/api/v1/services") {
      if (!mayListServices) return { status: 403, body: "{}" };
      // Someone else's Service holds .11 outside the deploy repository.
      const held = {
        kind: "Service",
        metadata: { name: "elsewhere", namespace: "tools", annotations: { "lbipam.cilium.io/ips": "10.0.8.11" } },
        spec: { type: "LoadBalancer", clusterIP: "10.96.0.1" },
      };
      return { status: 200, body: JSON.stringify({ items: [held] }) };
    }
    const one = /^\/api\/v1\/namespaces\/([^/]+)\/services\/([^/]+)$/.exec(path);
    if (one) {
      if (!mayReadServices) return { status: 403, body: "{}" };
      if (!inCluster.has(`${one[1]}/${one[2]}`)) return { status: 404, body: "{}" };
      const svc = { kind: "Service", metadata: { name: one[2], namespace: one[1] }, spec: { clusterIP: "10.96.0.9" } };
      return { status: 200, body: JSON.stringify(svc) };
    }
    if (path === "/apis/apps/v1/namespaces/apps/statefulsets")
      return { status: 200, body: JSON.stringify({ items: [legacy, plainOld] }) };
    if (path === "/apis/apps/v1/namespaces/apps/statefulsets/legacy")
      return { status: 200, body: JSON.stringify(legacy) };
    if (path === "/apis/apps/v1/namespaces/apps/statefulsets/plainold")
      return { status: 200, body: JSON.stringify(plainOld) };
    if (path.endsWith("/statefulsets")) return { status: 200, body: JSON.stringify({ items: [] }) };
    return { status: 404, body: "{}" };
  },
};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "member", password: PASSWORD });
  const session = async (u: string) => {
    const r = await signIn(db.sql, u, PASSWORD);
    if (!r.ok) throw new Error(u);
    return { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  };
  admin = await session("admin");
  member = await session("member");
  // An adopted instance whose address outside was written by hand, before stardust knew of it.
  repo = new MemoryRepo({
    "deploy/databases/kustomization.yaml": "resources:\n  - legacy\n",
    "deploy/databases/legacy/kustomization.yaml": "resources:\n  - db.service.yaml\n",
    "deploy/databases/legacy/db.service.yaml": [
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: legacy-db",
      "  namespace: apps",
      "  annotations:",
      "    lbipam.cilium.io/ips: 10.0.8.12",
      "spec:",
      "  type: LoadBalancer",
      "  clusterIP: 10.0.0.12",
      "  selector: { app: legacy }",
      "",
    ].join("\n"),
  });
  const sections = { databases: { external: EXTERNAL } };
  const ports = {
    database: databasePort(db.sql),
    deployRepo: { repo },
    cipher: { ...codec, revisionKey: "test-revision-key" },
    kube,
    databases: { statefulset: statefulSetPostgres({ kube, namespace: "databases", namespaces: ["apps"] }) },
  };
  const features = buildFeatures(createPluginRegistry([plugin]).resolve(sections), sections, ports, quiet, "test");
  const feature = features[0] as (typeof features)[number];
  await migratePlugin({ regional: db.sql, global: db.sql }, "databases", await feature.migrations());
  app = createApp(
    { version: "t" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features, log: quiet },
  );
});
after(async () => db.close());

const call = (method: string, path: string, body?: unknown, headers = admin) =>
  app.request(`/api/v1/plugins/databases${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const files = () => repo.files();
const resources = (path: string) => (parse(files()[path] ?? "resources: []") as { resources: string[] }).resources;
interface Svc {
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> };
  spec: {
    type: string;
    clusterIP: string;
    externalTrafficPolicy: string;
    allocateLoadBalancerNodePorts: boolean;
    selector: Record<string, string>;
  };
}
const service = (instance: string) => parse(files()[`deploy/databases/${instance}/db.service.yaml`] ?? "null") as Svc;

describe("an address outside the cluster", () => {
  it("comes with a new instance, in the same commit, at the smallest N free in the repository and the cluster", async () => {
    const before = repo.commitCount();
    const res = await call("POST", "/databases", { name: "orders" });
    assert.equal(res.status, 201);
    assert.equal(repo.commitCount(), before + 1, "one commit");
    // .10 is free; .11 is held in the cluster, .12 by the Service written by hand.
    assert.deepEqual(((await res.json()) as { external: unknown }).external, {
      address: "10.0.8.10",
      clusterIP: "10.0.0.10",
    });
    const svc = service("orders");
    assert.equal(svc.metadata.name, "orders-db");
    assert.equal(svc.metadata.namespace, "databases");
    assert.equal(svc.spec.type, "LoadBalancer");
    assert.equal(svc.spec.clusterIP, "10.0.0.10");
    assert.equal(svc.metadata.annotations["lbipam.cilium.io/ips"], "10.0.8.10");
    assert.equal(svc.metadata.annotations["service.cilium.io/forwarding-mode"], "dsr");
    assert.equal(svc.metadata.labels["example.com/ip-block"], "db");
    assert.equal(svc.spec.externalTrafficPolicy, "Cluster");
    assert.equal(svc.spec.allocateLoadBalancerNodePorts, false);
    assert.deepEqual(svc.spec.selector, { "app.kubernetes.io/name": "orders" });
    assert.ok(resources("deploy/databases/orders/kustomization.yaml").includes("db.service.yaml"));
    const own = parse(files()["deploy/databases/orders/service.yaml"] ?? "") as { spec: Record<string, unknown> };
    assert.equal(own.spec.type, undefined, "its own Service inside stays as it was");

    const second = await call("POST", "/databases", { name: "billing" });
    assert.equal(second.status, 201);
    assert.equal(service("billing").spec.clusterIP, "10.0.0.13", "past .11 (the cluster's) and .12 (by hand)");
    const [event] = (await listAudit(db.sql, { action: "databases.create" })).events;
    assert.deepEqual((event?.detail as { external?: unknown } | undefined)?.external, {
      address: "10.0.8.13",
      clusterIP: "10.0.0.13",
    });
  });

  it("without the cluster's Services, still never takes an address the repository holds", async () => {
    mayListServices = false;
    mayReadServices = false;
    try {
      assert.equal((await call("POST", "/databases", { name: "notes", external: false })).status, 201);
      assert.equal(files()["deploy/databases/notes/db.service.yaml"], undefined, "asked for none");
      const res = await call("POST", "/databases/notes/external");
      assert.equal(res.status, 201);
      // .11 is free as far as it can see; .10, .12 and .13 are in the repository.
      assert.equal(service("notes").spec.clusterIP, "10.0.0.11");
      assert.equal(((await res.json()) as { recognised: boolean }).recognised, false);
    } finally {
      mayListServices = true;
      mayReadServices = true;
    }
    assert.equal((await call("POST", "/databases/notes/external")).status, 409, "it has one already");
  });

  it("is recognised when written by hand for an instance stardust created, and kept as it is", async () => {
    assert.equal((await call("POST", "/databases", { name: "handmade", external: false })).status, 201);
    const byHand = [
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: handmade-db",
      "  namespace: databases",
      "  annotations:",
      "    lbipam.cilium.io/ips: 10.0.8.15",
      "spec:",
      "  type: LoadBalancer",
      "  clusterIP: 10.0.0.15",
      "  selector: { app.kubernetes.io/name: handmade }",
      "",
    ].join("\n");
    repo.push({ "deploy/databases/handmade/db.service.yaml": byHand }, "by hand");
    // Its own Service is in the cluster, as Flux applied it: that is not another one.
    inCluster.add("databases/handmade-db");
    const res = await call("POST", "/databases/handmade/external");
    assert.equal(res.status, 201);
    const body = (await res.json()) as { address: string; clusterIP: string; recognised: boolean };
    assert.deepEqual([body.address, body.clusterIP, body.recognised], ["10.0.8.15", "10.0.0.15", true]);
    assert.equal(files()["deploy/databases/handmade/db.service.yaml"], byHand, "not rewritten");
    assert.ok(resources("deploy/databases/handmade/kustomization.yaml").includes("db.service.yaml"));
  });

  it("is refused for an adopted instance: its app's Service gives it its address, and nothing is committed", async () => {
    for (const workload of ["legacy", "plainold"])
      assert.equal(
        (await call("POST", "/databases/adopt", { provider: "statefulset", namespace: "apps", workload })).status,
        201,
      );
    const before = repo.commitCount();
    const legacyFile = files()["deploy/databases/legacy/db.service.yaml"];
    for (const name of ["legacy", "plainold"]) {
      const res = await call("POST", `/databases/${name}/external`);
      assert.equal(res.status, 409, name);
      assert.match(((await res.json()) as { error: string }).error, /adopted: its own app's Service/);
    }
    assert.equal(repo.commitCount(), before, "nothing committed");
    assert.equal(files()["deploy/databases/plainold/db.service.yaml"], undefined);
    assert.equal(files()["deploy/databases/legacy/db.service.yaml"], legacyFile);
    const [plainold] = await db.sql<{ external_address: string | null }[]>`
      SELECT external_address FROM databases_instances WHERE name = 'plainold'`;
    assert.equal(plainold?.external_address, null, "nothing recorded");
    assert.equal((await call("POST", "/databases/plainold/external", undefined, member)).status, 403);
  });

  it("is not shown for an adopted instance that has one recorded, which still counts as held", async () => {
    // Recorded before adopted instances were refused: its app may hold it too.
    await db.sql`UPDATE databases_instances SET external_address = '10.0.8.14', external_cluster_ip = '10.0.0.14'
      WHERE name = 'plainold'`;
    const listing = (await (await call("GET", "/databases")).json()) as {
      instances: Array<{ name: string; external: { address: string } | null; connection: boolean }>;
      externalAddresses: boolean;
    };
    assert.equal(listing.externalAddresses, true);
    assert.deepEqual(
      listing.instances.map((i) => [i.name, i.external?.address ?? null, i.connection]),
      [
        ["billing", "10.0.8.13", true],
        ["handmade", "10.0.8.15", true],
        ["legacy", null, false],
        ["notes", "10.0.8.11", true],
        ["orders", "10.0.8.10", true],
        ["plainold", null, false],
      ],
    );
    assert.equal((await call("POST", "/databases", { name: "audit" })).status, 201);
    assert.equal(service("audit").spec.clusterIP, "10.0.0.16", "past .14 (recorded) and .15 (by hand)");
  });

  it("is refused when the cluster has a Service of that name the repository does not hold", async () => {
    inCluster.add("databases/clash-db");
    const before = repo.commitCount();
    const res = await call("POST", "/databases", { name: "clash" });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /Service databases\/clash-db already/);
    assert.equal(repo.commitCount(), before, "nothing committed");
    const [gone] = await db.sql`SELECT 1 FROM databases_instances WHERE name = 'clash'`;
    assert.equal(gone, undefined, "nor recorded");

    assert.equal((await call("POST", "/databases", { name: "later", external: false })).status, 201);
    inCluster.add("databases/later-db");
    const n = repo.commitCount();
    assert.equal((await call("POST", "/databases/later/external")).status, 409);
    assert.equal(repo.commitCount(), n, "nothing committed");
    assert.equal(files()["deploy/databases/later/db.service.yaml"], undefined);
  });
});

describe("the superuser's connection", () => {
  it("is shown to an administrator: the password the instance was sealed with, inside and outside, audited, not cached", async () => {
    const res = await call("POST", "/databases/orders/connection");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as {
      role: string;
      password: string;
      inCluster: { host: string; url: string };
      external: { host: string; url: string } | null;
    };
    const sealed = files()["deploy/databases/orders/superuser.secret.enc.yaml"] ?? "";
    const stored = Buffer.from(/password: ENC\[([^\]]+)\]/.exec(sealed)?.[1] ?? "", "base64").toString();
    assert.equal(stored.length, 32);
    assert.equal(body.password, stored);
    assert.equal(body.role, "postgres");
    assert.equal(
      body.inCluster.url,
      `postgres://postgres:${encodeURIComponent(stored)}@orders.databases.svc:5432/postgres`,
    );
    assert.equal(body.external?.url, `postgres://postgres:${encodeURIComponent(stored)}@10.0.8.10:5432/postgres`);
    const [event] = (await listAudit(db.sql, { action: "databases.reveal" })).events;
    assert.equal(event?.target, "orders");
    assert.equal(event?.actor.name, "admin");
    assert.ok(!JSON.stringify(event).includes(stored), "the value is in no audit entry");
  });

  it("is refused to anyone else, and is not there for an adopted instance", async () => {
    const audited = async () => (await listAudit(db.sql, { action: "databases.reveal" })).events.length;
    const n = await audited();
    assert.equal((await call("POST", "/databases/orders/connection", undefined, member)).status, 403);
    assert.equal((await call("GET", "/databases", undefined, member)).status, 403);
    const adopted = await call("POST", "/databases/legacy/connection");
    assert.equal(adopted.status, 409);
    assert.match(((await adopted.json()) as { error: string }).error, /apps\/legacy-pw/);
    assert.equal((await call("POST", "/databases/nope/connection")).status, 404);
    assert.equal(await audited(), n, "a refusal shows nothing and records no showing");
  });
});
