/**
 * The instances feature through the server and its schedule: a create saga
 * that resumes without making a second instance, DNS and the reverse name,
 * resizing, and deleting only with a fresh approval for that one instance.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildFeatures, createPluginRegistry, type Logger } from "@stardust/core";
import { MemoryCompute, MemoryDns } from "@stardust/core/testing";
import {
  databasePort,
  ensureBootstrapAdmin,
  guardStore,
  listAudit,
  migratePlugin,
  sagaStore,
  signIn,
} from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { driveCreates, plugin } from "@stardust/plugin-instances";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let db: TestDb;
let app: ReturnType<typeof createApp>;
let admin: Record<string, string>;
let feature: ReturnType<typeof buildFeatures>[number];
const compute = new MemoryCompute();
const dns = new MemoryDns(["example.com"]);
/** The fake cloud brings every pending instance up whenever the saga waits. */
const bootAll = async () => {
  for (const i of compute.instances.values()) i.state = "running";
};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  const r = await signIn(db.sql, "admin", PASSWORD);
  if (!r.ok) throw new Error("admin");
  admin = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  const sections = {
    instances: {
      sshKeys: ["ops"],
      cloudInit: "#cloud-config\nhostname: {{hostname}}\n",
      dns: { provider: "cloudflare", zone: "example.com", internalSuffix: "internal.example.com" },
      protected: { prefixes: ["db-"] },
    },
  };
  const ports = {
    database: databasePort(db.sql),
    sagas: sagaStore(db.sql),
    guards: guardStore(db.sql, db.sql),
    compute: { vultr: compute },
    dns: { cloudflare: dns },
  };
  [feature] = buildFeatures(createPluginRegistry([plugin]).resolve(sections), sections, ports, quiet, "test") as [
    ReturnType<typeof buildFeatures>[number],
  ];
  await migratePlugin({ regional: db.sql, global: db.sql }, "instances", await feature.migrations());
  app = createApp(
    { version: "t" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features: [feature], log: quiet },
  );
});
after(async () => db.close());

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/plugins/instances${path}`, {
    method,
    headers: admin,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const drive = () => driveCreates(feature.context, new AbortController().signal, bootAll);
const make = (hostname: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/instances", { hostname, region: "ams", plan: "small", image: "rocky-10", networks: ["n1"], ...extra });
const op = async (hostname: string) =>
  (
    await db.sql<{ status: string; instance_id: string | null; error: string | null }[]>`
    SELECT status, instance_id, error FROM instances_ops WHERE hostname = ${hostname} AND kind = 'create'`
  )[0];
const byHost = (hostname: string) => [...compute.instances.values()].find((i) => i.hostname === hostname);

describe("creating", () => {
  it("runs the saga in the background: the instance, its records, its reverse name, and its user data cleared", async () => {
    assert.equal((await make("Bad Host")).status, 400);
    const res = await make("web-1.example.com");
    assert.equal(res.status, 202);
    assert.equal((await make("web-1.example.com")).status, 409, "once");
    await drive();
    assert.equal((await op("web-1.example.com"))?.status, "succeeded");
    const made = byHost("web-1.example.com");
    assert.ok(made);
    assert.match(made.userData ?? "", /^# cleared/, "no bootstrap secrets left behind");
    const records = await dns.listRecords("example.com");
    assert.deepEqual(
      records.map((r) => [r.name, r.content]).sort(),
      [
        ["web-1.example.com", made.mainIp],
        ["web-1.internal.example.com", made.internalIp],
      ].sort(),
    );
    assert.equal(compute.reverse.get(made.mainIp ?? ""), "web-1.example.com");
  });

  it("resumes a create that stopped after the instance was made, without making a second", async () => {
    const res = await make("web-2.example.com");
    assert.equal(res.status, 202);
    // The cloud made it, then stardust stopped before saying so.
    await compute.create({
      label: "web-2.example.com",
      hostname: "web-2.example.com",
      region: "ams",
      plan: "small",
      image: "rocky-10",
      networks: ["n1"],
    });
    await drive();
    assert.equal([...compute.instances.values()].filter((i) => i.hostname === "web-2.example.com").length, 1);
    assert.equal((await op("web-2.example.com"))?.status, "succeeded");
  });

  it("lets one worker drive a create at a time", async () => {
    await make("web-3.example.com");
    await Promise.all([drive(), drive(), drive()]);
    assert.equal([...compute.instances.values()].filter((i) => i.hostname === "web-3.example.com").length, 1);
  });

  it("fails a create whose SSH key is not in the account, before anything is made", async () => {
    compute.catalog = async () => ({ ...(await new MemoryCompute().catalog()), sshKeys: [] });
    await make("web-4.example.com");
    await drive();
    const failed = await op("web-4.example.com");
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /no SSH key named ops/);
    assert.equal(byHost("web-4.example.com"), undefined);
    compute.catalog = MemoryCompute.prototype.catalog;
  });
});

describe("resizing and deleting", () => {
  it("resizes to a plan of the catalog only", async () => {
    const id = byHost("web-1.example.com")?.id ?? "";
    assert.equal((await call("POST", `/instances/${id}/resize`, { plan: "huge" })).status, 400);
    assert.equal((await call("POST", `/instances/${id}/resize`, { plan: "large" })).status, 200);
    assert.equal(byHost("web-1.example.com")?.plan, "large");
  });

  it("deletes with a fresh ticket for that instance, once, and takes its records along", async () => {
    const web1 = byHost("web-1.example.com")?.id ?? "";
    const web2 = byHost("web-2.example.com")?.id ?? "";
    assert.equal(
      (await call("POST", `/instances/${web1}/delete/approve`, { confirm: "web-2.example.com" })).status,
      400,
    );
    const approved = await call("POST", `/instances/${web1}/delete/approve`, { confirm: "web-1.example.com" });
    assert.equal(approved.status, 200);
    const { ticket } = (await approved.json()) as { ticket: string };
    assert.equal(
      (await call("POST", `/instances/${web2}/delete`, { ticket })).status,
      403,
      "a ticket is for one instance",
    );
    const done = await call("POST", `/instances/${web1}/delete`, { ticket });
    assert.equal(done.status, 200);
    assert.equal(((await done.json()) as { recordsRemoved: number }).recordsRemoved, 2);
    assert.equal(byHost("web-1.example.com"), undefined);
    assert.ok(!(await dns.listRecords("example.com")).some((r) => r.name.startsWith("web-1.")));
    assert.equal((await call("POST", `/instances/${web2}/delete`, { ticket })).status, 403);
    const actions = (await listAudit(db.sql, { action: "instances.delete" })).events.map((e) => e.action).sort();
    assert.deepEqual(actions, ["instances.delete", "instances.delete.approve"]);
  });

  it("never deletes a protected host, and asks a stale session to sign in again", async () => {
    await make("db-1.example.com");
    await drive();
    const id = byHost("db-1.example.com")?.id ?? "";
    assert.equal((await call("POST", `/instances/${id}/delete/approve`, { confirm: "db-1.example.com" })).status, 403);
    await db.sql`UPDATE sessions SET created_at = now() - interval '1 hour'`;
    const stale = await call("POST", `/instances/${id}/delete/approve`, { confirm: "db-1.example.com" });
    assert.equal(stale.status, 401);
    await db.sql`UPDATE sessions SET created_at = now()`;
    const listed = (await (await call("GET", "/instances")).json()) as {
      instances: Array<{ hostname: string; protected: boolean }>;
    };
    assert.equal(listed.instances.find((i) => i.hostname === "db-1.example.com")?.protected, true);
  });
});
