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
