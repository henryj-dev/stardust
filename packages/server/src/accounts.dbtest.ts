/**
 * Accounts without email: an administrator issues a one-time link, the person
 * sets a password through it; changing a password; seeing and ending
 * sessions; the audit log's detail view.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApiToken, createUser, ensureBootstrapAdmin, listAudit, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
let db: TestDb;
let app: ReturnType<typeof createApp>;
let admin: Record<string, string>;
const json = { "content-type": "application/json" };

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  const r = await signIn(db.sql, "admin", PASSWORD);
  if (!r.ok) throw new Error("admin");
  admin = { authorization: `Bearer ${r.token}`, ...json };
  app = createApp({ version: "test" }, { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }) });
});
after(async () => db.close());

const post = (path: string, body: unknown, headers: Record<string, string> = json) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

describe("one-time links", () => {
  it("invite someone without a password; the link works once and then never again", async () => {
    await createUser(db.sql, { username: "ada" });
    assert.equal(
      (await post("/api/v1/users/ada/links", { purpose: "reset" }, admin)).status,
      409,
      "no password to reset",
    );
    const issued = await post("/api/v1/users/ada/links", { purpose: "invite" }, admin);
    assert.equal(issued.status, 201);
    const { token, path } = (await issued.json()) as { token: string; path: string };
    assert.equal(path, `/account/link/${token}`);
    const [event] = (await listAudit(db.sql, { action: "user.link" })).events;
    assert.equal(event?.action, "user.link.invite");
    assert.ok(!JSON.stringify(event).includes(token), "the audit log never holds the token");

    assert.equal((await post("/api/v1/auth/link", { token, password: "short" })).status, 400);
    const used = await post("/api/v1/auth/link", { token, password: "a long new password" });
    assert.equal(used.status, 200);
    assert.deepEqual(await used.json(), { username: "ada" });
    assert.equal((await signIn(db.sql, "ada", "a long new password")).ok, true);
    assert.equal(
      (await post("/api/v1/auth/link", { token, password: "another long password" })).status,
      400,
      "used up",
    );
  });

  it("a reset ends what acted as the person, and a newer link replaces an older one", async () => {
    const before = await signIn(db.sql, "ada", "a long new password");
    assert.ok(before.ok);
    const apiToken = await createApiToken(db.sql, before.ok ? before.user.id : "", "ci", null);
    const first = (await (await post("/api/v1/users/ada/links", { purpose: "reset" }, admin)).json()) as {
      token: string;
    };
    const second = (await (await post("/api/v1/users/ada/links", { purpose: "reset" }, admin)).json()) as {
      token: string;
    };
    assert.equal((await post("/api/v1/auth/link", { token: first.token, password: "reset password one" })).status, 400);
    assert.equal(
      (await post("/api/v1/auth/link", { token: second.token, password: "reset password two" })).status,
      200,
    );
    const session = before.ok ? before.token : "";
    assert.equal(
      (await app.request("/api/v1/session", { headers: { authorization: `Bearer ${session}` } })).status,
      401,
    );
    assert.equal(
      (await app.request("/api/v1/session", { headers: { authorization: `Bearer ${apiToken.token}` } })).status,
      401,
      "API tokens end too",
    );
  });

  it("is refused for single sign-on accounts and unknown users", async () => {
    await createUser(db.sql, { username: "sso", oidc: { issuer: "https://id.example.com", subject: "s1" } });
    assert.equal((await post("/api/v1/users/sso/links", { purpose: "invite" }, admin)).status, 409);
    assert.equal((await post("/api/v1/users/nobody/links", { purpose: "invite" }, admin)).status, 404);
  });
});

describe("one's own account", () => {
  it("changes the password after checking the current one, ending the other sessions only", async () => {
    const a = await signIn(db.sql, "ada", "reset password two");
    const b = await signIn(db.sql, "ada", "reset password two");
    assert.ok(a.ok && b.ok);
    const me = { authorization: `Bearer ${a.ok ? a.token : ""}`, ...json };
    assert.equal(
      (await post("/api/v1/account/password", { current: "wrong password!!", password: "the next password" }, me))
        .status,
      403,
    );
    assert.equal(
      (await post("/api/v1/account/password", { current: "reset password two", password: "the next password" }, me))
        .status,
      200,
    );
    assert.equal((await app.request("/api/v1/session", { headers: me })).status, 200, "this session stays");
    assert.equal(
      (await app.request("/api/v1/session", { headers: { authorization: `Bearer ${b.ok ? b.token : ""}` } })).status,
      401,
    );
  });

  it("lists its sessions and ends one of them, never someone else's", async () => {
    const a = await signIn(db.sql, "ada", "the next password");
    const other = await signIn(db.sql, "ada", "the next password");
    assert.ok(a.ok && other.ok);
    const me = { authorization: `Bearer ${a.ok ? a.token : ""}` };
    const { sessions } = (await (await app.request("/api/v1/account/sessions", { headers: me })).json()) as {
      sessions: Array<{ id: string; current: boolean; via: string }>;
    };
    assert.ok(sessions.length >= 2);
    assert.equal(sessions.filter((s) => s.current).length, 1);
    assert.ok(sessions.every((s) => s.via === "password"));
    const target = sessions.find((s) => !s.current);
    const mine = await app.request(`/api/v1/account/sessions/${target?.id}`, { method: "DELETE", headers: me });
    assert.equal(mine.status, 200);
    const adminSession = (await (await app.request("/api/v1/account/sessions", { headers: admin })).json()) as {
      sessions: Array<{ id: string }>;
    };
    const theirs = await app.request(`/api/v1/account/sessions/${adminSession.sessions[0]?.id}`, {
      method: "DELETE",
      headers: me,
    });
    assert.equal(theirs.status, 404);
  });

  it("lets an administrator end every session and token of someone", async () => {
    const res = await post("/api/v1/users/ada/sessions/end", {}, admin);
    assert.equal(res.status, 200);
    assert.ok(((await res.json()) as { sessions: number }).sessions >= 1);
  });
});

describe("the audit log", () => {
  it("shows one event by id", async () => {
    const [latest] = (await listAudit(db.sql, { limit: 1 })).events;
    const res = await app.request(`/api/v1/audit/${latest?.id}`, { headers: admin });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { id: string }).id, latest?.id);
    assert.equal((await app.request("/api/v1/audit/999999999", { headers: admin })).status, 404);
    assert.equal((await app.request("/api/v1/audit/abc", { headers: admin })).status, 404);
  });
});
