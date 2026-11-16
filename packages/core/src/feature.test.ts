import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mayUse,
  migrationProblems,
  permissionProblems,
  type Route,
  routeProblems,
  scheduleProblems,
  tablePrefix,
} from "./feature.ts";
import { definePlugin } from "./plugin.ts";

const handle = async () => ({ status: 200 });
const read = { id: "runtime:read", description: "r", grantedTo: "signed-in" as const };
const restart = { id: "runtime:restart", description: "w", grantedTo: "admins" as const };

describe("permissions", () => {
  it("are named <plugin>:<verb>, once each, granted to admins or anyone signed in", () => {
    assert.deepEqual(permissionProblems("runtime", [read, restart]), []);
    assert.deepEqual(permissionProblems("runtime", [{ ...read, id: "other:read" }]), [
      'permission "other:read" must be named runtime:<verb>',
    ]);
    assert.deepEqual(permissionProblems("runtime", [read, read]), ['permission "runtime:read" is declared twice']);
    assert.deepEqual(permissionProblems("runtime", [{ ...read, grantedTo: "everyone" as never }]), [
      'permission "runtime:read" must be granted to admins, signed-in, project-readers, project-writers',
    ]);
  });

  it("per project: readers are viewers and maintainers, writers are maintainers; admins are both", () => {
    const view = { id: "runtime:view", description: "v", grantedTo: "project-readers" as const };
    const op = { id: "runtime:operate", description: "o", grantedTo: "project-writers" as const };
    const someone = { isAdmin: false };
    assert.deepEqual(
      [null, "viewer", "maintainer"].map((role) => mayUse(someone, view, role as never)),
      [false, true, true],
    );
    assert.deepEqual(
      [null, "viewer", "maintainer"].map((role) => mayUse(someone, op, role as never)),
      [false, false, true],
    );
    assert.equal(mayUse({ isAdmin: true }, op, null), true);
  });

  it("admins may use every permission; others only what is granted to signed-in; unknown is denied", () => {
    assert.equal(mayUse({ isAdmin: true }, restart), true);
    assert.equal(mayUse({ isAdmin: false }, restart), false);
    assert.equal(mayUse({ isAdmin: false }, read), true);
    assert.equal(mayUse({ isAdmin: true }, undefined), false);
  });
});

describe("routes", () => {
  const route = (over: Partial<Route>): Route => ({
    method: "GET",
    path: "/x",
    permission: "runtime:read",
    handle,
    ...over,
  });

  it("name a declared permission, and every change names an audit action of the plugin", () => {
    assert.deepEqual(
      routeProblems("runtime", [route({}), route({ method: "POST", audit: "runtime.restart" })], [read]),
      [],
    );
    assert.deepEqual(routeProblems("runtime", [route({ permission: "runtime:nope" })], [read]), [
      'route GET /x: permission "runtime:nope" is not declared',
    ]);
    assert.deepEqual(routeProblems("runtime", [route({ method: "POST" })], [read]), [
      "route POST /x: a route that changes something needs an audit action",
    ]);
    assert.deepEqual(routeProblems("runtime", [route({ method: "DELETE", audit: "project.delete" })], [read]), [
      'route DELETE /x: audit action "project.delete" must be runtime.<what>',
    ]);
  });

  it("with a per-project permission, name the project in the path", () => {
    const view = { id: "runtime:view", description: "v", grantedTo: "project-readers" as const };
    assert.deepEqual(
      routeProblems("runtime", [route({ path: "/projects/:project/pods", permission: "runtime:view" })], [view]),
      [],
    );
    assert.deepEqual(routeProblems("runtime", [route({ path: "/pods/:id", permission: "runtime:view" })], [view]), [
      "route GET /pods/:id: a per-project permission needs :project in the path",
    ]);
  });

  it("have a clean path, once each", () => {
    assert.deepEqual(routeProblems("runtime", [route({ path: "x" })], [read]), [
      "route GET x: the path must start with / and hold no spaces or ..",
    ]);
    assert.deepEqual(routeProblems("runtime", [route({ path: "/a/../b" })], [read]).length, 1);
    assert.deepEqual(routeProblems("runtime", [route({}), route({})], [read]), ["route GET /x is declared twice"]);
  });
});

describe("schedules", () => {
  const run = async () => {};
  it("have unique ids and run no more often than every 10 seconds", () => {
    assert.deepEqual(scheduleProblems([{ id: "drift", everyMs: 60_000, run }]), []);
    assert.deepEqual(scheduleProblems([{ id: "Drift", everyMs: 60_000, run }]), [
      'schedule "Drift" must be lower-case words joined by "-"',
    ]);
    assert.deepEqual(scheduleProblems([{ id: "fast", everyMs: 500, run }]), [
      'schedule "fast" must run at most every 10 seconds (everyMs >= 10000)',
    ]);
  });
});

describe("migrations", () => {
  it("prefix tables with the plugin's name", () => {
    assert.equal(tablePrefix("dns-cloudflare"), "dns_cloudflare_");
  });

  it("may create, change and write only the plugin's own tables", () => {
    const own = `
      -- users would be a problem, but this is a comment
      CREATE TABLE runtime_pods (id text PRIMARY KEY, project text REFERENCES projects (id) ON UPDATE CASCADE ON DELETE CASCADE);
      CREATE INDEX runtime_pods_idx ON runtime_pods (project);
      ALTER TABLE runtime_pods ADD COLUMN seen timestamptz;
      INSERT INTO runtime_pods (id) VALUES ('x');`;
    assert.deepEqual(migrationProblems("runtime", [{ name: "0001_pods.sql", scope: "regional", sql: own }]), []);
    for (const sql of [
      "DROP TABLE users;",
      "ALTER TABLE projects ADD COLUMN x int;",
      "CREATE TABLE IF NOT EXISTS other_things (id int);",
      'CREATE TABLE "runtime_x" (id int); UPDATE runs SET status = 1;',
      "DELETE FROM audit_events;",
      "CREATE INDEX evil ON users (username);",
      "CREATE TABLE public.runtime_x (id int);",
    ]) {
      assert.equal(migrationProblems("runtime", [{ name: "0001_x.sql", scope: "regional", sql }]).length, 1, sql);
    }
  });

  it("say which database they run in", () => {
    const sql = "CREATE TABLE runtime_a (id int);";
    assert.deepEqual(migrationProblems("runtime", [{ name: "0001_a.sql", scope: "everywhere" as never, sql }]), [
      'migration "0001_a.sql" must say its scope: global or regional',
    ]);
  });

  it("are named NNNN_<words>.sql, once each", () => {
    const sql = "CREATE TABLE runtime_a (id int);";
    assert.deepEqual(migrationProblems("runtime", [{ name: "first.sql", scope: "regional", sql }]), [
      'migration "first.sql" must be named NNNN_<words>.sql',
    ]);
    assert.deepEqual(
      migrationProblems("runtime", [
        { name: "0001_a.sql", scope: "regional", sql },
        { name: "0001_a.sql", scope: "regional", sql },
      ]),
      ['migration "0001_a.sql" is declared twice'],
    );
  });
});

describe("definePlugin", () => {
  const base = { manifest: { name: "runtime", description: "r" }, validateConfig: () => [] };
  it("refuses bad permissions, schedules and capabilities at definition", () => {
    assert.throws(
      () => definePlugin({ ...base, permissions: [{ ...read, id: "x:y" }] }),
      /must be named runtime:<verb>/,
    );
    assert.throws(
      () => definePlugin({ ...base, schedules: [{ id: "s", everyMs: 1, run: async () => {} }] }),
      /10 seconds/,
    );
    assert.throws(() => definePlugin({ ...base, capabilities: ["restart"] }), /must start with runtime\./);
  });
});
