/**
 * The repository access check: whether stardust can read a repository before
 * a project names it, and how. Administrators only, like creating a project.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { RepoAccess } from "@stardust/core";
import { createUser, ensureBootstrapAdmin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
let db: TestDb;
const asked: string[] = [];
const repoAccess = async (repo: string): Promise<RepoAccess> => {
  asked.push(repo);
  if (repo === "acme/open") return { readable: "public" };
  if (repo === "acme/private") return { readable: "app", installation: "all" };
  if (repo === "acme/down") throw new Error("GitHub answered 503");
  return { readable: "none" };
};
const resolveTarget = async () => ({ ref: "refs/heads/main", sha: "f".repeat(40) });

const bearer = async (username: string) => {
  const result = await signIn(db.sql, username, PASSWORD);
  if (!result.ok) throw new Error(`cannot sign in as ${username}`);
  return { authorization: `Bearer ${result.token}` };
};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "dev", password: PASSWORD });
});
after(async () => db.close());

describe("GET /api/v1/source/access", () => {
  it("says how a repository is read, for administrators only", async () => {
    const app = createApp({ version: "test" }, { sql: db.sql, resolveTarget, repoAccess });
    const admin = await bearer("admin");
    const open = await app.request("/api/v1/source/access?repo=acme/open", { headers: admin });
    assert.equal(open.status, 200);
    assert.deepEqual(await open.json(), { repo: "acme/open", readable: "public" });
    const wide = await app.request("/api/v1/source/access?repo=acme/private", { headers: admin });
    assert.deepEqual(await wide.json(), { repo: "acme/private", readable: "app", installation: "all" });
    const gone = await app.request("/api/v1/source/access?repo=acme/gone", { headers: admin });
    assert.deepEqual(await gone.json(), { repo: "acme/gone", readable: "none" });

    const dev = await app.request("/api/v1/source/access?repo=acme/open", { headers: await bearer("dev") });
    assert.equal(dev.status, 403);
    assert.equal((await app.request("/api/v1/source/access?repo=acme/open")).status, 401);
  });

  it("refuses anything but owner/name, without asking the host", async () => {
    const app = createApp({ version: "test" }, { sql: db.sql, resolveTarget, repoAccess });
    const admin = await bearer("admin");
    asked.length = 0;
    for (const repo of ["", "acme", "acme/x/y", "../etc", "acme/..", "acme/x?y=1"]) {
      const res = await app.request(`/api/v1/source/access?repo=${encodeURIComponent(repo)}`, { headers: admin });
      assert.equal(res.status, 400, repo);
    }
    assert.deepEqual(asked, []);
  });

  it("answers 502 when the host fails, and 404 when the host cannot say", async () => {
    const admin = await bearer("admin");
    const app = createApp({ version: "test" }, { sql: db.sql, resolveTarget, repoAccess });
    const down = await app.request("/api/v1/source/access?repo=acme/down", { headers: admin });
    assert.equal(down.status, 502);
    assert.match(((await down.json()) as { error: string }).error, /503/);
    const mute = createApp({ version: "test" }, { sql: db.sql, resolveTarget });
    assert.equal((await mute.request("/api/v1/source/access?repo=acme/open", { headers: admin })).status, 404);
  });
});
