/**
 * Addresses outside the cluster against a real Git deploy repository: a bare
 * "remote" on disk, written through GitCliRepo as the server writes it, and a
 * second clone that plays the person writing by hand. The in-memory
 * repository answers some reads differently from Git, so the paths that
 * commit (or must not) run here too.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildFeatures, createPluginRegistry, type KubeStreamClient, type Logger } from "@stardust/core";
import { databasePort, ensureBootstrapAdmin, migratePlugin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { plugin } from "@stardust/plugin-databases";
import { statefulSetPostgres } from "@stardust/plugin-db-statefulset";
import { GitCliRepo } from "@stardust/plugin-gitops-git";
import { parse } from "yaml";
import { createApp } from "./app.ts";
import { fakeCodec } from "./env-testing.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const EXTERNAL = {
  clusterIPs: "10.0.0.0/24",
  addresses: "10.0.8.0/24",
  first: 10,
  last: 20,
  addressAnnotation: "lbipam.cilium.io/ips",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  })
    .toString()
    .trim();

/** An app's own database, adopted: its manifests (and its Service outside) live with the app. */
const shop = {
  metadata: { namespace: "apps", name: "shop" },
  spec: {
    replicas: 1,
    serviceName: "shop",
    selector: { matchLabels: { app: "shop" } },
    template: {
      spec: {
        containers: [
          {
            image: "postgres:16-alpine",
            env: [{ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-pw", key: "pw" } } }],
          },
        ],
      },
    },
  },
  status: { readyReplicas: 1 },
};

/** Services the cluster has: the app's own `shop-db`, and others added by the tests. */
const inCluster = new Set(["apps/shop-db"]);
const kube: KubeStreamClient = {
  async stream() {
    throw new Error("not used");
  },
  async request(_m, path) {
    if (path === "/api/v1/services") return { status: 403, body: "{}" };
    const one = /^\/api\/v1\/namespaces\/([^/]+)\/services\/([^/]+)$/.exec(path);
    if (one) return inCluster.has(`${one[1]}/${one[2]}`) ? { status: 200, body: "{}" } : { status: 404, body: "{}" };
    if (path === "/apis/apps/v1/namespaces/apps/statefulsets")
      return { status: 200, body: JSON.stringify({ items: [shop] }) };
    if (path === "/apis/apps/v1/namespaces/apps/statefulsets/shop") return { status: 200, body: JSON.stringify(shop) };
    if (path.endsWith("/statefulsets")) return { status: 200, body: JSON.stringify({ items: [] }) };
    return { status: 404, body: "{}" };
  },
};

let tmp: string;
let remote: string;
let hand: string;
let db: TestDb;
let app: ReturnType<typeof createApp>;
let admin: Record<string, string>;

const head = () => git(hand, "ls-remote", remote, "refs/heads/main").split(/\s/)[0];
const remoteFile = (path: string) => {
  git(hand, "fetch", "-q", "origin");
  try {
    return execFileSync("git", ["show", `origin/main:${path}`], {
      cwd: hand,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return null;
  }
};
const write = (path: string, content: string) => {
  mkdirSync(dirname(join(hand, path)), { recursive: true });
  writeFileSync(join(hand, path), content);
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "databases-external-git-"));
  remote = join(tmp, "remote.git");
  hand = join(tmp, "hand");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "clone", "-q", remote, hand);
  git(hand, "checkout", "-q", "-b", "main");
  write("deploy/databases/kustomization.yaml", "resources:\n  - backup\n");
  // A listed directory that holds directories, as the backups do.
  write("deploy/databases/backup/kustomization.yaml", "resources: []\n");
  write("deploy/databases/backup/jobs/keep.yaml", "# kept\n");
  git(hand, "add", "-A");
  git(hand, "commit", "-q", "-m", "seed");
  git(hand, "push", "-q", "origin", "main");

  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  const r = await signIn(db.sql, "admin", PASSWORD);
  if (!r.ok) throw new Error("admin");
  admin = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  const sections = { databases: { external: EXTERNAL } };
  const ports = {
    database: databasePort(db.sql),
    deployRepo: { repo: new GitCliRepo({ url: remote, branch: "main" }) },
    cipher: { ...fakeCodec(), revisionKey: "test-revision-key" },
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
after(async () => {
  await db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/plugins/databases${path}`, {
    method,
    headers: admin,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const clusterIP = (path: string) =>
  (parse(remoteFile(path) ?? "null") as { spec: { clusterIP: string } }).spec.clusterIP;

describe("an address outside the cluster, in a Git deploy repository", () => {
  it("is committed with an instance stardust creates", async () => {
    const res = await call("POST", "/databases", { name: "orders" });
    assert.equal(res.status, 201);
    assert.equal(clusterIP("deploy/databases/orders/db.service.yaml"), "10.0.0.10");
  });

  it("is refused for an adopted instance, and nothing is pushed", async () => {
    assert.equal(
      (await call("POST", "/databases/adopt", { provider: "statefulset", namespace: "apps", workload: "shop" })).status,
      201,
    );
    const before = head();
    const res = await call("POST", "/databases/shop/external");
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /adopted/);
    assert.equal(head(), before, "nothing pushed");
    assert.equal(remoteFile("deploy/databases/shop/db.service.yaml"), null);
  });

  it("is refused when the cluster has a Service of that name, and nothing is pushed", async () => {
    inCluster.add("databases/clash-db");
    const before = head();
    const res = await call("POST", "/databases", { name: "clash" });
    assert.equal(res.status, 409);
    assert.equal(head(), before, "nothing pushed");
    assert.equal(remoteFile("deploy/databases/clash/kustomization.yaml"), null);
  });

  it("is recognised when written by hand for an instance stardust created", async () => {
    assert.equal((await call("POST", "/databases", { name: "notes", external: false })).status, 201);
    git(hand, "pull", "-q", "origin", "main");
    const byHand = [
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: notes-db",
      "  namespace: databases",
      "  annotations:",
      "    lbipam.cilium.io/ips: 10.0.8.12",
      "spec:",
      "  type: LoadBalancer",
      "  clusterIP: 10.0.0.12",
      "",
    ].join("\n");
    write("deploy/databases/notes/db.service.yaml", byHand);
    git(hand, "add", "-A");
    git(hand, "commit", "-q", "-m", "by hand");
    git(hand, "push", "-q", "origin", "main");
    inCluster.add("databases/notes-db");
    const res = await call("POST", "/databases/notes/external");
    assert.equal(res.status, 201);
    const body = (await res.json()) as { address: string; recognised: boolean };
    assert.deepEqual([body.address, body.recognised], ["10.0.8.12", true]);
    assert.equal(remoteFile("deploy/databases/notes/db.service.yaml"), byHand, "not rewritten");
    const listed = parse(remoteFile("deploy/databases/notes/kustomization.yaml") ?? "") as { resources: string[] };
    assert.ok(listed.resources.includes("db.service.yaml"));
  });
});
