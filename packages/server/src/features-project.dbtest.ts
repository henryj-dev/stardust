/** Per-project plugin permissions: viewers read, maintainers change, others do not see the project. */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { buildFeatures, createPluginRegistry, definePlugin, type Logger } from "@stardust/core";
import { createUser, ensureBootstrapAdmin, setProjectRole, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const probe = definePlugin({
  manifest: { name: "probe", description: "Test only" },
  validateConfig: () => [],
  permissions: [
    { id: "probe:view", description: "v", grantedTo: "project-readers" },
    { id: "probe:poke", description: "p", grantedTo: "project-writers" },
  ],
  routes: () => [
    {
      method: "GET",
      path: "/projects/:project/x",
      permission: "probe:view",
      handle: async ({ params }) => ({ status: 200, body: { project: params.project } }),
    },
    {
      method: "POST",
      path: "/projects/:project/x",
      permission: "probe:poke",
      audit: "probe.poke",
      handle: async () => ({ status: 200, body: {} }),
    },
    {
      method: "GET",
      path: "/projects/:project/log",
      permission: "probe:view",
      handle: async () => ({
        status: 200,
        stream: (async function* () {
          yield new TextEncoder().encode("<b>one</b>\n");
          yield new TextEncoder().encode("two\n");
        })(),
      }),
    },
  ],
});

let db: TestDb;
const as: Record<string, Record<string, string>> = {};
before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await db.sql`INSERT INTO projects (id, name) VALUES ('demo', 'Demo')`;
  for (const [name, role] of [
    ["viewer", "viewer"],
    ["maint", "maintainer"],
    ["outsider", null],
  ] as const) {
    await createUser(db.sql, { username: name, password: PASSWORD });
    const [u] = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE username = ${name}`;
    if (role) await setProjectRole(db.sql, "demo", u?.id ?? "", role);
  }
  for (const name of ["admin", "viewer", "maint", "outsider"]) {
    const r = await signIn(db.sql, name, PASSWORD);
    if (!r.ok) throw new Error(name);
    as[name] = { authorization: `Bearer ${r.token}` };
  }
});
after(async () => db.close());

it("checks the caller's role in the route's project", async () => {
  const sections = { probe: {} };
  const features = buildFeatures(createPluginRegistry([probe]).resolve(sections), sections, {}, quiet, "test");
  const app = createApp(
    { version: "t" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features, log: quiet },
  );
  const status = async (who: string, method: string) =>
    (await app.request("/api/v1/plugins/probe/projects/demo/x", { method, headers: as[who] ?? {} })).status;
  assert.deepEqual(
    await Promise.all(["admin", "maint", "viewer", "outsider"].map((who) => status(who, "GET"))),
    [200, 200, 200, 404],
  );
  assert.deepEqual(
    await Promise.all(["admin", "maint", "viewer", "outsider"].map((who) => status(who, "POST"))),
    [200, 200, 403, 404],
  );
});

it("streams a plugin's text as plain text that is never sniffed", async () => {
  const sections = { probe: {} };
  const features = buildFeatures(createPluginRegistry([probe]).resolve(sections), sections, {}, quiet, "test");
  const app = createApp(
    { version: "t" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features, log: quiet },
  );
  const res = await app.request("/api/v1/plugins/probe/projects/demo/log", { headers: as.viewer ?? {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await res.text(), "<b>one</b>\ntwo\n");
});
