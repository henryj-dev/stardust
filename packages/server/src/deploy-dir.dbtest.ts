/** A component that names no deploy directory gets the configured template's. */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { MemoryRepo } from "@stardust/core/testing";
import { createUser, ensureBootstrapAdmin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
let db: TestDb;
const headers: Record<string, Record<string, string>> = {};
const apps: Record<string, ReturnType<typeof createApp>> = {};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "someone", password: PASSWORD });
  for (const name of ["admin", "someone"]) {
    const r = await signIn(db.sql, name, PASSWORD);
    if (!r.ok) throw new Error(name);
    headers[name] = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  }
  const base = { sql: db.sql, resolveTarget: async () => ({ ref: "refs/heads/main", sha: "a".repeat(40) }) };
  const repo = new MemoryRepo({});
  apps.templated = createApp(
    { version: "test" },
    { ...base, deployRepo: { repo, deployDirTemplate: "clusters/one/apps/{project}/{component}" } },
  );
  apps.plain = createApp({ version: "test" }, { ...base, deployRepo: { repo } });
});
after(async () => db.close());

const call = (app: string, who: string, method: string, path: string, body?: unknown) =>
  (apps[app] as ReturnType<typeof createApp>).request(path, {
    method,
    headers: headers[who] ?? {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it("tells administrators the template, and no one else", async () => {
  assert.deepEqual(await (await call("templated", "admin", "GET", "/api/v1/deploy/defaults")).json(), {
    deployDirTemplate: "clusters/one/apps/{project}/{component}",
  });
  assert.deepEqual(await (await call("plain", "admin", "GET", "/api/v1/deploy/defaults")).json(), {
    deployDirTemplate: null,
  });
  assert.equal((await call("templated", "someone", "GET", "/api/v1/deploy/defaults")).status, 403);
});

it("fills the directory a component leaves out, keeps one it names", async () => {
  const res = await call("templated", "admin", "PUT", "/api/v1/projects/pico", {
    githubRepo: "acme/pico",
    components: [
      { name: "push", pipeline: "C" },
      { name: "web", pipeline: "C", deployDir: "elsewhere/web" },
    ],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { components: Array<{ name: string; deployDir: string }> };
  assert.deepEqual(
    body.components.map((c) => [c.name, c.deployDir]),
    [
      ["push", "clusters/one/apps/pico/push"],
      ["web", "elsewhere/web"],
    ],
  );
  const one = await call("templated", "admin", "PUT", "/api/v1/projects/pico/components/relay", { pipeline: "C" });
  const project = (await one.json()) as { components: Array<{ name: string; deployDir: string }> };
  assert.equal(project.components.find((c) => c.name === "relay")?.deployDir, "clusters/one/apps/pico/relay");
});

it("still needs a directory without a template", async () => {
  const res = await call("plain", "admin", "PUT", "/api/v1/projects/bare", {
    components: [{ name: "x", pipeline: "C" }],
  });
  assert.equal(res.status, 400);
});
