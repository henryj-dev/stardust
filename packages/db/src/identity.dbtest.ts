import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { can } from "@stardust/core";
import {
  authenticate,
  createUser,
  ensureBootstrapAdmin,
  hashPassword,
  projectRole,
  resetPassword,
  setProjectRole,
  signIn,
  signOut,
  verifyPassword,
} from "./identity.ts";
import { putProject } from "./projects.ts";
import { createTestDb, type TestDb } from "./testing.ts";

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => db.close());

const PASSWORD = "correct horse battery";

describe("passwords", () => {
  it("hashes with a salt, verifies, rejects wrong and short ones", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    assert.notEqual(a, b, "salted");
    assert.ok(!a.includes(PASSWORD));
    assert.equal(await verifyPassword(PASSWORD, a), true);
    assert.equal(await verifyPassword("wrong password!", a), false);
    assert.equal(await verifyPassword(PASSWORD, "garbage"), false);
    await assert.rejects(hashPassword("short"), /at least 12/);
  });
});

describe("bootstrap administrator", () => {
  it("is created once, even when two processes start together", async () => {
    const results = await Promise.all([
      ensureBootstrapAdmin(db.sql, "admin", PASSWORD),
      ensureBootstrapAdmin(db.sql, "admin", PASSWORD),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await ensureBootstrapAdmin(db.sql, "admin", "another password"), false, "not when users exist");
    const [row] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE is_admin`;
    assert.equal(row?.n, 1);
  });
});

describe("sessions", () => {
  it("signs in with a token stored only as a hash, authenticates it, signs out", async () => {
    const result = await signIn(db.sql, "admin", PASSWORD);
    assert.ok(result.ok);
    const stored = await db.sql<{ token_hash: Buffer }[]>`SELECT token_hash FROM sessions`;
    assert.ok(stored.every((s) => !s.token_hash.toString("utf8").includes(result.token)));
    assert.equal((await authenticate(db.sql, result.token))?.username, "admin");
    await signOut(db.sql, result.token);
    assert.equal(await authenticate(db.sql, result.token), null);
  });

  it("rejects wrong passwords and unknown users the same way", async () => {
    assert.deepEqual(await signIn(db.sql, "admin", "wrong password!"), { ok: false, reason: "invalid" });
    assert.deepEqual(await signIn(db.sql, "nobody", PASSWORD), { ok: false, reason: "invalid" });
  });

  it("an unknown user costs about as much as a wrong password", async () => {
    const time = async (user: string) => {
      const t = performance.now();
      await signIn(db.sql, user, "wrong password!", { maxFailures: 1000, windowMinutes: 1, sessionHours: 1 });
      return performance.now() - t;
    };
    await time("nobody"); // warm the dummy hash
    // The fastest of several tries: load from other tests only ever adds time,
    // so minimums compare the work itself. Without the dummy hash an unknown
    // user costs a database query, a small fraction of one scrypt derivation.
    const fastest = async (user: string) => {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 6; i++) min = Math.min(min, await time(user));
      return min;
    };
    const known = await fastest("admin");
    const unknown = await fastest("nobody");
    assert.ok(unknown > known * 0.5, `unknown ${unknown.toFixed(1)}ms vs known ${known.toFixed(1)}ms`);
  });

  it("locks a username after too many failures, even for the right password", async () => {
    await createUser(db.sql, { username: "target", password: PASSWORD });
    const policy = { maxFailures: 3, windowMinutes: 15, sessionHours: 1 };
    for (let i = 0; i < 3; i++) await signIn(db.sql, "target", "wrong password!", policy);
    assert.deepEqual(await signIn(db.sql, "target", PASSWORD, policy), { ok: false, reason: "locked" });
  });

  it("expired sessions and disabled users do not authenticate", async () => {
    await createUser(db.sql, { username: "temp", password: PASSWORD });
    const result = await signIn(db.sql, "temp", PASSWORD);
    assert.ok(result.ok);
    await db.sql`UPDATE sessions SET expires_at = now() - interval '1 second'`;
    assert.equal(await authenticate(db.sql, result.token), null);
    const again = await signIn(db.sql, "temp", PASSWORD);
    assert.ok(again.ok);
    await db.sql`UPDATE users SET disabled = true WHERE username = 'temp'`;
    assert.equal(await authenticate(db.sql, again.token), null);
  });
});

describe("project roles and permissions", () => {
  it("grants per project; administrators may do everything", async () => {
    await putProject(db.sql, {
      id: "demo",
      name: "Demo",
      githubRepo: null,
      pipelineDef: null,
      components: [],
      metadata: {},
      webhookKind: "repo",
    });
    const viewer = await createUser(db.sql, { username: "viewer", password: PASSWORD });
    await setProjectRole(db.sql, "demo", viewer.id, "viewer");
    const role = await projectRole(db.sql, viewer.id, "demo");
    assert.equal(role, "viewer");
    assert.equal(can(viewer, "project:read", role), true);
    assert.equal(can(viewer, "project:write", role), false);
    assert.equal(can(viewer, "admin"), false);
    assert.equal(can(viewer, "project:read", await projectRole(db.sql, viewer.id, "other")), false);
    assert.equal(can({ isAdmin: true }, "admin"), true);
    await setProjectRole(db.sql, "demo", viewer.id, null);
    assert.equal(await projectRole(db.sql, viewer.id, "demo"), null);
  });
});

describe("password reset", () => {
  it("sets a new password, ends the user's sessions and clears the lockout", async () => {
    await createUser(db.sql, { username: "forgetful", password: PASSWORD });
    const before = await signIn(db.sql, "forgetful", PASSWORD);
    assert.ok(before.ok);
    for (let i = 0; i < 3; i++) await signIn(db.sql, "forgetful", "wrong password!");
    assert.equal(await resetPassword(db.sql, "forgetful", "a brand new password"), true);
    assert.equal(await authenticate(db.sql, before.token), null);
    assert.equal((await signIn(db.sql, "forgetful", PASSWORD)).ok, false);
    assert.equal((await signIn(db.sql, "forgetful", "a brand new password")).ok, true);
    assert.equal(await resetPassword(db.sql, "nobody-here", "a brand new password"), false);
  });
});
