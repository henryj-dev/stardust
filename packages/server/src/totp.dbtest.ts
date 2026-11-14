/**
 * Two-step sign-in for local accounts and re-authentication, through the API
 * against a real database. Codes are computed from the secret the API hands
 * out, as an authenticator app would.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { stepAt, totpCode } from "@stardust/core";
import { createUser, ensureBootstrapAdmin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { type AuthPolicy, createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const KEY = "k".repeat(40);
let db: TestDb;
const json = { "content-type": "application/json" };

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "ada", password: PASSWORD });
  await createUser(db.sql, { username: "bob", password: PASSWORD });
});
after(async () => db.close());

const appWith = (auth: Partial<AuthPolicy> = {}) =>
  createApp(
    { version: "test" },
    {
      sql: db.sql,
      resolveTarget: async () => ({ ref: "", sha: "" }),
      auth: { localEnabled: true, totp: "optional", reauthMinutes: 10, issuer: "stardust", totpKey: KEY, ...auth },
    },
  );
const send = (app: ReturnType<typeof appWith>, method: string, path: string, token?: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const login = async (app: ReturnType<typeof appWith>, username: string) =>
  (await (await send(app, "POST", "/api/v1/auth/login", undefined, { username, password: PASSWORD })).json()) as {
    token?: string;
    secondFactor?: string;
    challenge?: string;
  };
/** The code an app would show `offset` steps from now. */
const codeOf = (secret: string, offset = 0) => totpCode(secret, stepAt(new Date()) + offset);

describe("two-step sign-in", () => {
  let app: ReturnType<typeof appWith>;
  before(() => {
    app = appWith();
  });
  let secret = "";
  let recovery: string[] = [];

  it("is set up with a secret for the app, confirmed with a first code, and sealed in the database", async () => {
    const { token } = await login(app, "ada");
    const setup = await send(app, "POST", "/api/v1/account/totp/setup", token);
    assert.equal(setup.status, 200);
    const begun = (await setup.json()) as { secret: string; uri: string };
    secret = begun.secret;
    assert.match(begun.uri, /^otpauth:\/\/totp\/stardust:ada\?secret=/);
    const [stored] = await db.sql<{ secret: string }[]>`SELECT secret FROM user_totp`;
    assert.ok(stored?.secret.startsWith("v1:") && !stored.secret.includes(secret), "sealed, not the secret itself");

    assert.equal((await send(app, "POST", "/api/v1/account/totp/confirm", token, { code: "000000" })).status, 400);
    const confirmed = await send(app, "POST", "/api/v1/account/totp/confirm", token, { code: codeOf(secret) });
    assert.equal(confirmed.status, 200);
    recovery = ((await confirmed.json()) as { recoveryCodes: string[] }).recoveryCodes;
    assert.equal(recovery.length, 10);
    assert.equal((await send(app, "POST", "/api/v1/account/totp/setup", token)).status, 409, "set up already");
  });

  it("asks for a code after the password, and accepts each code once", async () => {
    const first = await login(app, "ada");
    assert.equal(first.token, undefined, "no session before the code");
    assert.equal(first.secondFactor, "totp");
    const wrong = await send(app, "POST", "/api/v1/auth/login/totp", undefined, {
      challenge: first.challenge,
      code: "123456",
    });
    assert.equal(wrong.status, 401);
    // The confirming code used this step; the next step's code signs in.
    const code = codeOf(secret, 1);
    const ok = await send(app, "POST", "/api/v1/auth/login/totp", undefined, { challenge: first.challenge, code });
    assert.equal(ok.status, 200);
    assert.ok(((await ok.json()) as { token: string }).token);
    const again = await login(app, "ada");
    const reused = await send(app, "POST", "/api/v1/auth/login/totp", undefined, { challenge: again.challenge, code });
    assert.equal(reused.status, 401, "a code works once");
    const used = await send(app, "POST", "/api/v1/auth/login/totp", undefined, {
      challenge: first.challenge,
      code: codeOf(secret, 1),
    });
    assert.equal(used.status, 401, "a challenge works once");
  });

  it("takes a recovery code once, and gives up a challenge after five tries", async () => {
    const a = await login(app, "ada");
    assert.equal(
      (await send(app, "POST", "/api/v1/auth/login/totp", undefined, { challenge: a.challenge, code: recovery[0] }))
        .status,
      200,
    );
    const b = await login(app, "ada");
    assert.equal(
      (await send(app, "POST", "/api/v1/auth/login/totp", undefined, { challenge: b.challenge, code: recovery[0] }))
        .status,
      401,
    );
    for (let i = 0; i < 5; i++)
      await send(app, "POST", "/api/v1/auth/login/totp", undefined, { challenge: b.challenge, code: "000000" });
    const after = await send(app, "POST", "/api/v1/auth/login/totp", undefined, {
      challenge: b.challenge,
      code: recovery[1],
    });
    assert.equal(after.status, 401, "too many tries: the challenge is gone");
    assert.match(((await after.json()) as { error: string }).error, /expired/);
  });
});

describe("policy", () => {
  it("required: a password session without TOTP may only set it up", async () => {
    const app = appWith({ totp: "required" });
    const { token } = await login(app, "bob");
    const blocked = await send(app, "GET", "/api/v1/projects", token);
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { totpSetupRequired: boolean }).totpSetupRequired, true);
    assert.equal((await send(app, "GET", "/api/v1/session", token)).status, 200);
    assert.equal((await send(app, "POST", "/api/v1/account/totp/setup", token)).status, 200);
  });

  it("off: no second step and no setup; local sign-in can be turned off", async () => {
    const off = appWith({ totp: "off" });
    const { token } = await login(off, "ada");
    assert.ok(token, "TOTP is not asked for when it is off");
    assert.equal((await send(off, "POST", "/api/v1/account/totp/setup", token)).status, 404);
    const noLocal = appWith({ localEnabled: false });
    assert.equal(
      (await send(noLocal, "POST", "/api/v1/auth/login", undefined, { username: "ada", password: PASSWORD })).status,
      403,
    );
  });
});

describe("re-authentication", () => {
  it("guards what cannot be undone: a stale session confirms it is itself first", async () => {
    const app = appWith();
    const r = await signIn(db.sql, "admin", PASSWORD);
    assert.ok(r.ok);
    const token = r.ok ? r.token : "";
    await db.sql`UPDATE sessions SET created_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE username = 'admin')`;
    const stale = await send(app, "DELETE", "/api/v1/users/ada/totp", token);
    assert.equal(stale.status, 401);
    assert.equal(((await stale.json()) as { reauthRequired: boolean }).reauthRequired, true);
    assert.equal(
      (await send(app, "POST", "/api/v1/account/reauth", token, { password: "wrong password!!" })).status,
      403,
    );
    assert.equal((await send(app, "POST", "/api/v1/account/reauth", token, { password: PASSWORD })).status, 200);
    assert.equal(
      (await send(app, "DELETE", "/api/v1/users/ada/totp", token)).status,
      200,
      "an administrator resets a lost phone",
    );
    const { token: ada } = await login(app, "ada");
    assert.ok(ada, "ada signs in with her password alone again");
  });
});
