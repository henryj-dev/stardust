/** The domains plugin through the server: zones from two providers, RDAP data, records changed by an admin. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildFeatures, createPluginRegistry, type Logger } from "@stardust/core";
import { MemoryDns } from "@stardust/core/testing";
import { createUser, databasePort, ensureBootstrapAdmin, listAudit, migratePlugin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { plugin, refreshRdap, syncZones } from "@stardust/plugin-domains";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let db: TestDb;
const as: Record<string, Record<string, string>> = {};
const cloudflare = new MemoryDns(["example.test", "shop.test"]);
const parallax = new MemoryDns(["internal.test"], ["internal", "external"]);
let app: ReturnType<typeof createApp>;
let feature: ReturnType<typeof buildFeatures>[number];

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "member", password: PASSWORD });
  for (const who of ["admin", "member"]) {
    const r = await signIn(db.sql, who, PASSWORD);
    if (!r.ok) throw new Error(who);
    as[who] = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  }
  const sections = { domains: {} };
  const ports = { database: databasePort(db.sql), globalDatabase: databasePort(db.sql), dns: { cloudflare, parallax } };
  [feature] = buildFeatures(createPluginRegistry([plugin]).resolve(sections), sections, ports, quiet, "test") as [
    ReturnType<typeof buildFeatures>[number],
  ];
  await migratePlugin({ regional: db.sql, global: db.sql }, "domains", await feature.migrations());
  app = createApp(
    { version: "t" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features: [feature], log: quiet },
  );
});
after(async () => db.close());

const fakeRdap = {
  lookup: async (name: string) =>
    name === "shop.test"
      ? {
          registrar: "Shop Registrar",
          expires: new Date(Date.now() + 10 * 86_400_000).toISOString(),
          registered: null,
          nameservers: ["ns.shop.test"],
          status: [],
        }
      : name === "example.test"
        ? (() => {
            throw new Error("RDAP rdap.test answered 503");
          })()
        : null,
};

describe("domains", () => {
  it("collects the zones of every provider, with registration data and the errors of the ones that failed", async () => {
    assert.deepEqual(await syncZones(feature.context), { zones: 3 });
    await refreshRdap(feature.context, undefined, fakeRdap as never);
    const res = await app.request("/api/v1/plugins/domains/domains", { headers: as.admin ?? {} });
    const { domains } = (await res.json()) as {
      domains: Array<{
        name: string;
        provider: string;
        registrar: string | null;
        daysLeft: number | null;
        rdapError: string | null;
      }>;
    };
    assert.deepEqual(
      domains.map((d) => [d.name, d.provider]),
      [
        ["shop.test", "cloudflare"],
        ["example.test", "cloudflare"],
        ["internal.test", "parallax"],
      ],
      "soonest expiry first",
    );
    assert.equal(domains[0]?.registrar, "Shop Registrar");
    assert.deepEqual(
      (domains[0] as { nameservers?: unknown }).nameservers,
      ["ns.shop.test"],
      "stored as a list, not a string",
    );
    assert.ok((domains[0]?.daysLeft ?? 0) >= 9);
    assert.match(domains[1]?.rdapError ?? "", /503/);
  });

  it("drops a zone its provider no longer holds", async () => {
    cloudflare.zones.splice(cloudflare.zones.indexOf("example.test"), 1);
    await syncZones(feature.context);
    const [row] = await db.sql`SELECT count(*)::int AS n FROM domains_zones WHERE name = 'example.test'`;
    assert.equal(row?.n, 0);
  });

  it("lets an administrator set and remove a record through the zone's provider, audited; members see nothing", async () => {
    assert.equal((await app.request("/api/v1/plugins/domains/domains", { headers: as.member ?? {} })).status, 403);
    const put = await app.request("/api/v1/plugins/domains/domains/internal.test/records", {
      method: "PUT",
      headers: as.admin ?? {},
      body: JSON.stringify({ name: "api.internal.test", type: "A", content: "10.0.0.5", ttl: 60, view: "internal" }),
    });
    assert.equal(put.status, 200);
    const { record } = (await put.json()) as { record: { id: string; view: string } };
    assert.equal(record.view, "internal");
    assert.equal(parallax.records.length, 1);
    const bad = await app.request("/api/v1/plugins/domains/domains/internal.test/records", {
      method: "PUT",
      headers: as.admin ?? {},
      body: JSON.stringify({ name: "api.elsewhere.test", type: "A", content: "10.0.0.5", ttl: 60, view: "internal" }),
    });
    assert.equal(bad.status, 400);
    const detail = (await (
      await app.request("/api/v1/plugins/domains/domains/internal.test", { headers: as.admin ?? {} })
    ).json()) as {
      records: unknown[];
      capabilities: { views: string[] };
    };
    assert.equal(detail.records.length, 1);
    assert.deepEqual(detail.capabilities.views, ["internal", "external"]);
    const del = await app.request(`/api/v1/plugins/domains/domains/internal.test/records/${record.id}?view=internal`, {
      method: "DELETE",
      headers: as.admin ?? {},
    });
    assert.equal(del.status, 200);
    assert.equal(parallax.records.length, 0);
    const actions = (await listAudit(db.sql, { action: "domains.record" })).events.map((e) => e.action).sort();
    assert.deepEqual(actions, ["domains.record.delete", "domains.record.set"]);
  });
});
