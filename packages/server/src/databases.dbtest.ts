/**
 * The databases feature through the server: an instance created and one
 * adopted, an application granted its own role with the env written to its
 * layer, a backup per namespace, and a grant revoked, all as commits.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildFeatures, createPluginRegistry, type KubeClient, type Logger } from "@stardust/core";
import { MemoryRepo } from "@stardust/core/testing";
import {
  databasePort,
  ensureBootstrapAdmin,
  listAudit,
  migratePlugin,
  projectCatalog,
  putProject,
  signIn,
} from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { plugin } from "@stardust/plugin-databases";
import { statefulSetPostgres } from "@stardust/plugin-db-statefulset";
import { parse } from "yaml";
import { createApp } from "./app.ts";
import { projectEnvPort } from "./env.ts";
import { fakeCodec } from "./env-testing.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const RECIPIENT = `age1${"q".repeat(58)}`;
let db: TestDb;
let repo: MemoryRepo;
let app: ReturnType<typeof createApp>;
let admin: Record<string, string>;
const codec = fakeCodec();

const legacy = {
  metadata: { namespace: "apps", name: "legacy" },
  spec: {
    replicas: 1,
    serviceName: "legacy-svc",
    template: {
      spec: {
        containers: [
          {
            image: "postgres:16",
            env: [{ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "legacy-pw", key: "pw" } } }],
          },
        ],
      },
    },
  },
  status: { readyReplicas: 1 },
};
const kube: KubeClient = {
  async request(_m, path) {
    if (path === "/apis/apps/v1/namespaces/apps/statefulsets")
      return { status: 200, body: JSON.stringify({ items: [legacy] }) };
    if (path === "/apis/apps/v1/namespaces/apps/statefulsets/legacy")
      return { status: 200, body: JSON.stringify(legacy) };
    if (path.endsWith("/statefulsets")) return { status: 200, body: JSON.stringify({ items: [] }) };
    return { status: 404, body: "{}" };
  },
};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  const r = await signIn(db.sql, "admin", PASSWORD);
  if (!r.ok) throw new Error("admin");
  admin = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  await putProject(db.sql, {
    id: "shop",
    name: "Shop",
    githubRepo: "acme/shop",
    pipelineDef: null,
    components: [{ name: "api", pipeline: "C", deployDir: "apps/shop/api" }],
    metadata: {},
  });
  repo = new MemoryRepo({
    "apps/shop/api/kustomization.yaml": "resources:\n  - deployment.yaml\n",
    "apps/shop/api/deployment.yaml": [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "  namespace: shop",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: api",
      "          image: registry.example.com/shop/api:abc",
      "",
    ].join("\n"),
  });
  const sections = {
    databases: {
      backup: {
        schedule: "15 3 * * *",
        storage: { endpoint: "https://s3.example.com", bucket: "backups", credentials: "db-backup-s3", prefix: "pg" },
        recipient: RECIPIENT,
        retentionHours: 168,
      },
    },
  };
  const editor = { repo, codec, revisionKey: "test-revision-key" };
  const ports = {
    database: databasePort(db.sql),
    deployRepo: { repo },
    cipher: { ...codec, revisionKey: "test-revision-key" },
    projects: projectCatalog(db.sql),
    projectEnv: projectEnvPort(editor, db.sql),
    databases: { statefulset: statefulSetPostgres({ kube, namespace: "databases", namespaces: ["apps"] }) },
  };
  const features = buildFeatures(createPluginRegistry([plugin]).resolve(sections), sections, ports, quiet, "test");
  await migratePlugin(
    { regional: db.sql, global: db.sql },
    "databases",
    await (features[0] as (typeof features)[number]).migrations(),
  );
  app = createApp(
    { version: "t" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features, log: quiet },
  );
});
after(async () => db.close());

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/plugins/databases${path}`, {
    method,
    headers: admin,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const files = () => repo.files();
const resources = (path: string) => (parse(files()[path] ?? "resources: []") as { resources: string[] }).resources;

describe("databases", () => {
  it("lists what it could adopt, with what it cannot", async () => {
    const { unmanaged, instances } = (await (await call("GET", "/databases")).json()) as {
      unmanaged: Array<{ workload: string; adoptable: boolean; version: string }>;
      instances: unknown[];
    };
    assert.deepEqual(instances, []);
    assert.deepEqual(
      unmanaged.map((u) => [u.workload, u.adoptable, u.version]),
      [["legacy", true, "16"]],
    );
  });

  it("creates an instance in one commit: its manifests, a sealed superuser password, its backup", async () => {
    assert.equal((await call("POST", "/databases", { name: "Orders" })).status, 400);
    const res = await call("POST", "/databases", { name: "orders", storage: "5Gi" });
    assert.equal(res.status, 201);
    const f = files();
    assert.ok(f["deploy/databases/orders/statefulset.yaml"]?.includes("storage: 5Gi"));
    const secret = f["deploy/databases/orders/superuser.secret.enc.yaml"] ?? "";
    assert.match(secret, /ENC\[/, "sealed");
    assert.deepEqual(resources("deploy/databases/kustomization.yaml"), ["orders", "backup"]);
    assert.deepEqual(resources("deploy/databases/orders/kustomization.yaml").sort(), [
      "service.yaml",
      "statefulset.yaml",
      "superuser.secret.enc.yaml",
    ]);
    assert.ok(f["deploy/databases/backup/databases/db-backup.yaml"]?.includes("orders-superuser"));
    assert.equal((await call("POST", "/databases", { name: "orders" })).status, 409);
  });

  it("adopts a running instance without touching it, and backs it up in its own namespace", async () => {
    const before = repo.commitCount();
    assert.equal(
      (await call("POST", "/databases/adopt", { provider: "statefulset", namespace: "apps", workload: "nope" })).status,
      404,
    );
    const res = await call("POST", "/databases/adopt", {
      provider: "statefulset",
      namespace: "apps",
      workload: "legacy",
    });
    assert.equal(res.status, 201);
    assert.equal(repo.commitCount(), before + 1);
    const f = files();
    assert.equal(
      Object.keys(f).filter((p) => p.startsWith("deploy/databases/legacy/")).length,
      0,
      "nothing of its own is written",
    );
    const cron = f["deploy/databases/backup/apps/db-backup.yaml"] ?? "";
    assert.ok(cron.includes("legacy-pw") && cron.includes("legacy-svc.apps.svc"));
    assert.deepEqual(resources("deploy/databases/backup/kustomization.yaml"), ["databases", "apps"]);
    const { instances, unmanaged } = (await (await call("GET", "/databases")).json()) as {
      instances: Array<{ name: string; ready: boolean }>;
      unmanaged: unknown[];
    };
    assert.deepEqual(
      instances.map((i) => [i.name, i.ready]),
      [
        ["legacy", true],
        ["orders", false],
      ],
    );
    assert.deepEqual(unmanaged, []);
  });

  let password = "";
  it("grants an application its own role: a Job and sealed password, then the env of its layer", async () => {
    assert.equal((await call("POST", "/databases/orders/grants", { project: "nope", role: "shop_api" })).status, 404);
    assert.equal((await call("POST", "/databases/orders/grants", { project: "shop", role: "shop; drop" })).status, 400);
    const res = await call("POST", "/databases/orders/grants", { project: "shop", layer: "api", role: "shop_api" });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { env: string[]; envCommit: string | null };
    assert.deepEqual(body.env, ["DATABASE_URL", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]);
    assert.ok(body.envCommit);
    assert.ok(!JSON.stringify(body).includes("ENC["), "nothing sealed comes back");
    const f = files();
    const grantFiles = (paths: Record<string, string>) =>
      Object.entries(paths).filter(
        ([p]) =>
          p.startsWith("deploy/databases/orders/grant-shop-api/") &&
          !p.includes("secret") &&
          !p.endsWith("kustomization.yaml"),
      );
    const job = grantFiles(f)[0];
    assert.equal(grantFiles(f).length, 1);
    assert.ok(job, "the grant Job is written");
    assert.match(job?.[1] ?? "", /name: orders-grant-shop-api-[0-9a-f]{8}/);
    const appSecret = f["deploy/databases/orders/grant-shop-api/password.secret.enc.yaml"] ?? "";
    assert.ok(resources("deploy/databases/orders/kustomization.yaml").includes("grant-shop-api"));
    password = Buffer.from(/password: ENC\[([^\]]+)\]/.exec(appSecret)?.[1] ?? "", "base64").toString();
    assert.equal(password.length, 32);
    const envSecret = Object.entries(f).find(([p]) => p.includes("shop/api/runtime.secret.enc.yaml"))?.[1] ?? "";
    const pgpassword = Buffer.from(/PGPASSWORD: ENC\[([^\]]+)\]/.exec(envSecret)?.[1] ?? "", "base64").toString();
    assert.equal(pgpassword, password, "the application's env carries the same password the Job sets");
    assert.ok(!Object.values(f).some((c) => c.includes(password)), "never in plain text");
    const [event] = (await listAudit(db.sql, { action: "databases.grant" })).events;
    assert.ok(!JSON.stringify(event).includes(password));
  });

  it("names a new Job for a new password, and keeps a role to its project", async () => {
    const jobs = () =>
      Object.entries(files())
        .filter(
          ([p]) =>
            p.startsWith("deploy/databases/orders/grant-shop-api/") &&
            !p.includes("secret") &&
            !p.endsWith("kustomization.yaml"),
        )
        .map(([, c]) => c);
    const first = jobs()[0];
    assert.equal(
      (await call("POST", "/databases/orders/grants", { project: "shop", layer: "api", role: "shop_api" })).status,
      201,
    );
    assert.equal(jobs().length, 1, "the old Job is replaced, not kept");
    assert.notEqual(jobs()[0], first, "a new password makes a new Job, which runs again");
    await putProject(db.sql, {
      id: "other",
      name: "Other",
      githubRepo: "acme/other",
      pipelineDef: null,
      components: [],
      metadata: {},
    });
    assert.equal((await call("POST", "/databases/orders/grants", { project: "other", role: "shop_api" })).status, 409);
  });

  it("revokes: the env loses its settings, the Job and Secret go, the role and its data stay", async () => {
    const res = await call("DELETE", "/databases/orders/grants/shop_api");
    assert.equal(res.status, 200);
    const f = files();
    assert.ok(!Object.keys(f).some((p) => p.includes("grant-shop-api")));
    assert.ok(!resources("deploy/databases/orders/kustomization.yaml").includes("grant-shop-api"));
    assert.ok(f["deploy/databases/orders/statefulset.yaml"], "the instance stays");
    const envSecret = Object.entries(f).find(([p]) => p.includes("shop/api/runtime.secret.enc.yaml"))?.[1] ?? "";
    assert.ok(!envSecret.includes("PGPASSWORD"));
    assert.equal((await call("DELETE", "/databases/orders/grants/shop_api")).status, 404);
    // On an adopted instance the directory holds only grants, and goes with the last one.
    assert.equal(
      (
        await call("POST", "/databases/legacy/grants", {
          project: "shop",
          layer: "api",
          role: "shop_ro",
          envPrefix: "LEGACY_",
        })
      ).status,
      201,
    );
    assert.ok(resources("deploy/databases/kustomization.yaml").includes("legacy"));
    assert.ok(Object.keys(files()).some((p) => p.startsWith("deploy/databases/legacy/grant-shop-ro/")));
    assert.equal((await call("DELETE", "/databases/legacy/grants/shop_ro")).status, 200);
    assert.ok(!Object.keys(files()).some((p) => p.startsWith("deploy/databases/legacy/")));
    assert.ok(!resources("deploy/databases/kustomization.yaml").includes("legacy"));
    assert.ok(resources("deploy/databases/kustomization.yaml").includes("orders"));
    const actions = (await listAudit(db.sql, { action: "databases" })).events.map((e) => e.action).sort();
    assert.deepEqual(actions, [
      "databases.adopt",
      "databases.create",
      "databases.grant",
      "databases.grant",
      "databases.grant",
      "databases.revoke",
      "databases.revoke",
    ]);
  });
});
