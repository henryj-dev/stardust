/**
 * A plugin's routes and tables, end to end: a test-only plugin adds a table
 * and two routes; enabled, both work behind sign-in, its permissions and the
 * audit log; not enabled, neither exists.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildFeatures, createPluginRegistry, definePlugin, type Feature, type Logger } from "@stardust/core";
import { createUser, databasePort, ensureBootstrapAdmin, listAudit, migratePlugin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const notes = definePlugin({
  manifest: { name: "notes", description: "Test only: notes in a table of its own." },
  validateConfig: () => [],
  requires: ["database"],
  permissions: [
    { id: "notes:read", description: "Read notes", grantedTo: "signed-in" },
    { id: "notes:write", description: "Write notes", grantedTo: "admins" },
  ],
  capabilities: ["notes.write"],
  migrations: async () => [
    { name: "0001_notes.sql", sql: "CREATE TABLE notes_items (id serial PRIMARY KEY, text text NOT NULL);" },
  ],
  routes: ({ ports }) => {
    const database = ports.database;
    if (!database) throw new Error("no database");
    return [
      {
        method: "GET",
        path: "/items",
        permission: "notes:read",
        handle: async () => ({ status: 200, body: { items: await database.query("SELECT text FROM notes_items") } }),
      },
      {
        method: "POST",
        path: "/items",
        permission: "notes:write",
        audit: "notes.item.add",
        handle: async ({ body }) => {
          const text = (body as { text?: unknown } | null)?.text;
          if (typeof text !== "string") return { status: 400, body: { error: "text is required" } };
          await database.query("INSERT INTO notes_items (text) VALUES ($1)", [text]);
          return { status: 201, body: { ok: true }, audit: { target: "item", detail: { length: text.length } } };
        },
      },
      {
        method: "DELETE",
        path: "/items/:id",
        permission: "notes:write",
        audit: "notes.item.remove",
        handle: async () => {
          throw new Error("broken on purpose");
        },
      },
    ];
  },
});

let db: TestDb;
const headers: Record<string, Record<string, string>> = {};
const as = (who: string): Record<string, string> => headers[who] ?? {};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "reader", password: PASSWORD });
  for (const name of ["admin", "reader"]) {
    const result = await signIn(db.sql, name, PASSWORD);
    if (!result.ok) throw new Error(`cannot sign in as ${name}`);
    headers[name] = { authorization: `Bearer ${result.token}`, "content-type": "application/json" };
  }
});
after(async () => db.close());

/** The server as main.ts builds it, with `plugins:` of stardust.yaml as given. */
async function serverWith(sections: Record<string, unknown>) {
  const plugins = createPluginRegistry([notes]).resolve(sections);
  const ports = { database: databasePort(db.sql) };
  const features: Feature[] = buildFeatures(plugins, sections, ports, quiet);
  for (const f of features) await migratePlugin(db.sql, f.plugin, await f.migrations());
  return createApp(
    { version: "test" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features, log: quiet },
  );
}

describe("a plugin's routes and tables", () => {
  it("not enabled: no table, no route, no capability", async () => {
    const app = await serverWith({});
    const [table] = await db.sql`SELECT to_regclass('notes_items') AS t`;
    assert.equal(table?.t, null);
    assert.equal((await app.request("/api/v1/plugins/notes/items", { headers: as("admin") })).status, 404);
    assert.deepEqual(await (await app.request("/api/v1/capabilities", { headers: as("admin") })).json(), {
      plugins: [],
    });
  });

  it("enabled: its table exists and its migration is recorded once under its name", async () => {
    await serverWith({ notes: {} });
    await serverWith({ notes: {} });
    const [table] = await db.sql`SELECT to_regclass('notes_items') AS t`;
    assert.equal(table?.t, "notes_items");
    const rows = await db.sql`SELECT name FROM schema_migrations WHERE name LIKE 'notes/%'`;
    assert.deepEqual(
      rows.map((r) => r.name),
      ["notes/0001_notes.sql"],
    );
  });

  it("enabled: routes sit behind sign-in and the plugin's permissions, and changes are audited", async () => {
    const app = await serverWith({ notes: {} });
    const url = "/api/v1/plugins/notes/items";
    assert.equal((await app.request(url)).status, 401);

    const post = (who: string, body: string) => app.request(url, { method: "POST", headers: as(who), body });
    assert.equal((await post("reader", JSON.stringify({ text: "hi" }))).status, 403, "writing is for admins");
    assert.equal((await post("admin", "{not json")).status, 400);
    assert.equal((await post("admin", JSON.stringify({}))).status, 400);
    assert.equal((await post("admin", JSON.stringify({ text: "hello" }))).status, 201);

    const read = await app.request(url, { headers: as("reader") });
    assert.equal(read.status, 200, "reading is for anyone signed in");
    assert.deepEqual(await read.json(), { items: [{ text: "hello" }] });

    const { events } = await listAudit(db.sql, { action: "notes" });
    assert.equal(events.length, 1, "only the change that went through is audited");
    assert.equal(events[0]?.action, "notes.item.add");
    assert.equal(events[0]?.actor.name, "admin");
    assert.deepEqual(events[0]?.detail, { length: 5 });

    assert.deepEqual(await (await app.request("/api/v1/capabilities", { headers: as("reader") })).json(), {
      plugins: [{ name: "notes", capabilities: ["notes.write"] }],
    });
  });

  it("a failing route answers 500 without its error, and is not audited", async () => {
    const app = await serverWith({ notes: {} });
    const res = await app.request("/api/v1/plugins/notes/items/1", { method: "DELETE", headers: as("admin") });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "internal error" });
    assert.equal((await listAudit(db.sql, { action: "notes.item.remove" })).events.length, 0);
  });

  it("refuses a migration that touches a table outside the plugin's names", async () => {
    await assert.rejects(
      migratePlugin(db.sql, "notes", [{ name: "0002_evil.sql", sql: "DROP TABLE users;" }]),
      /notes may only use tables named notes_\*/,
    );
    const [users] = await db.sql`SELECT to_regclass('users') AS t`;
    assert.equal(users?.t, "users");
  });
});
