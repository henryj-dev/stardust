/**
 * Two databases, as several regions will have: decisions about access read
 * the global one, regional data stays in the region's own. Here both are
 * test schemas on one server.
 */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { ensureBootstrapAdmin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
let regional: TestDb;
let global: TestDb;
before(async () => {
  regional = await createTestDb();
  global = await createTestDb();
});
after(async () => {
  await regional.close();
  await global.close().catch(() => {});
});

it("signs in and checks sessions against the global database, and refuses when it cannot", async () => {
  // The account exists only in the global database.
  await ensureBootstrapAdmin(global.sql, "admin", PASSWORD);
  const app = createApp(
    { version: "test" },
    { sql: regional.sql, globalSql: global.sql, resolveTarget: async () => ({ ref: "", sha: "" }) },
  );
  const login = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const { token } = (await login.json()) as { token: string };
  assert.equal((await signIn(regional.sql, "admin", PASSWORD)).ok, false, "the regional database has no accounts");

  const auth = { authorization: `Bearer ${token}` };
  const projects = await app.request("/api/v1/projects", { headers: auth });
  assert.equal(projects.status, 200);
  const [event] = await global.sql`SELECT action FROM audit_events WHERE action = 'auth.login'`;
  assert.equal(event?.action, "auth.login", "the audit log is global");

  // Without the global database there is no decision about access: refused, never allowed.
  await global.sql.end();
  const cut = await app.request("/api/v1/projects", { headers: auth });
  assert.notEqual(cut.status, 200);
  assert.ok(cut.status >= 500, `expected a refusal, got ${cut.status}`);
});

it("changes a project only in the region that owns it, and names the owner elsewhere", async () => {
  const one = await createTestDb();
  try {
    await ensureBootstrapAdmin(one.sql, "admin", PASSWORD);
    const r = await signIn(one.sql, "admin", PASSWORD);
    if (!r.ok) throw new Error("admin");
    const auth = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
    const regionApp = (region: string) =>
      createApp(
        { version: "test" },
        { sql: one.sql, region, resolveTarget: async () => ({ ref: "refs/heads/main", sha: "a".repeat(40) }) },
      );
    const ams = regionApp("dev-ams");
    const fra = regionApp("prod-fra");
    const put = (app: ReturnType<typeof regionApp>, body: unknown) =>
      app.request("/api/v1/projects/shop", { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal((await put(ams, { githubRepo: "acme/shop", components: [] })).status, 200);
    const [row] = await one.sql<{ metadata: { region?: string } }[]>`SELECT metadata FROM projects WHERE id = 'shop'`;
    assert.equal(row?.metadata.region, "dev-ams", "made in dev-ams, owned by it");

    const refused = await put(fra, { githubRepo: "acme/shop", components: [], metadata: {} });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      error: "project shop belongs to region dev-ams: change it there",
      region: "dev-ams",
    });
    const run = await fra.request("/api/v1/projects/shop/runs", { method: "POST", headers: auth, body: "{}" });
    assert.equal(run.status, 409);
    const plugin = await fra.request("/api/v1/plugins/runtime/projects/shop/restart", {
      method: "POST",
      headers: auth,
      body: "{}",
    });
    assert.equal(plugin.status, 409, "project-scoped plugin routes too");
    assert.equal((await fra.request("/api/v1/projects/shop", { headers: auth })).status, 200, "reading is anywhere");

    assert.equal((await put(ams, { githubRepo: "acme/shop", components: [], metadata: { note: "x" } })).status, 200);
    const [kept] = await one.sql<
      { metadata: { region?: string; note?: string } }[]
    >`SELECT metadata FROM projects WHERE id = 'shop'`;
    assert.deepEqual(kept?.metadata, { note: "x", region: "dev-ams" }, "an edit keeps the owner");
  } finally {
    await one.close();
  }
});

it("gives a region copies of the global plugin tables, and the global database only those", async () => {
  const { migratePlugin } = await import("@stardust/db");
  const regionalDb = await createTestDb();
  const globalDb = await createTestDb();
  try {
    await migratePlugin({ regional: regionalDb.sql, global: globalDb.sql }, "probe", [
      { name: "0001_g.sql", scope: "global", sql: "CREATE TABLE probe_shared (id int)" },
      { name: "0002_r.sql", scope: "regional", sql: "CREATE TABLE probe_here (id int)" },
    ]);
    const tables = async (db: TestDb) =>
      (
        await db.sql<
          { t: string }[]
        >`SELECT table_name AS t FROM information_schema.tables WHERE table_name LIKE 'probe_%' AND table_schema = current_schema() ORDER BY 1`
      ).map((r) => r.t);
    assert.deepEqual(await tables(globalDb), ["probe_shared"]);
    assert.deepEqual(await tables(regionalDb), ["probe_here", "probe_shared"]);
  } finally {
    await regionalDb.close();
    await globalDb.close();
  }
});
