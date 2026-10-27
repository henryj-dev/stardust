/**
 * OpenID sign-in through the HTTP API against a real database and a fake
 * provider, as the dashboard drives it: start, the provider approves, the
 * callback comes back with the state the dashboard kept in its cookie.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createUser } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { type AccessRules, createOidc } from "@stardust/plugin-identity-oidc";
import { FakeProvider, type Issued } from "@stardust/plugin-identity-oidc/testing";
import { createApp } from "./app.ts";

const CLIENT = { clientId: "stardust", clientSecret: "client-secret" };
const REDIRECT = "https://stardust.example.com/login/oidc/callback";
let db: TestDb;
let idp: FakeProvider;

before(async () => {
  db = await createTestDb();
  idp = await FakeProvider.start(CLIENT);
});
after(async () => {
  await idp.close();
  await db.close();
});

async function appWith(rules: AccessRules = {}, autoCreate = true) {
  const client = await createOidc({
    issuer: idp.issuer,
    ...CLIENT,
    redirectUri: REDIRECT,
    allowInsecureRequests: true,
  });
  return createApp(
    { version: "test" },
    {
      sql: db.sql,
      webhookSecret: "s",
      compare: async () => ({ files: null }),
      oidc: { client: async () => client, redirectUri: REDIRECT, displayName: "Test SSO", rules, autoCreate },
    },
  );
}
type App = Awaited<ReturnType<typeof appWith>>;
const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

/** Starts, approves at the provider, and returns what the dashboard would send back. */
async function approved(app: App, issued: Issued) {
  const start = (await (await app.request("/api/v1/auth/oidc/start", { method: "POST" })).json()) as {
    url: string;
    state: string;
  };
  const { code, state } = idp.approve(start.url, issued);
  return { query: new URLSearchParams({ code, state }).toString(), state: start.state };
}
async function signIn(app: App, issued: Issued) {
  const res = await app.request("/api/v1/auth/oidc/callback", post(await approved(app, issued)));
  return {
    status: res.status,
    body: (await res.json()) as { token?: string; user?: { username: string; isAdmin: boolean }; error?: string },
  };
}
const person = (sub: string, extra: Record<string, unknown> = {}): Issued => ({
  claims: { sub, preferred_username: sub, ...extra },
});

describe("OpenID sign-in", () => {
  it("is advertised, and a first sign-in creates the account and a working session", async () => {
    const app = await appWith();
    assert.deepEqual(await (await app.request("/api/v1/auth/methods")).json(), {
      password: true,
      oidc: { displayName: "Test SSO" },
    });
    const first = await signIn(app, person("ada"));
    assert.equal(first.status, 200, first.body.error ?? "");
    const session = await app.request("/api/v1/session", { headers: { authorization: `Bearer ${first.body.token}` } });
    assert.equal(((await session.json()) as { user: { username: string } }).user.username, "ada");
    const again = await signIn(app, person("ada"));
    assert.equal(again.status, 200);
    const [row] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE username = 'ada'`;
    assert.equal(row?.n, 1, "the same subject maps to the same account");
  });

  it("uses a pending login once, and only with the state the browser kept", async () => {
    const app = await appWith();
    const flow = await approved(app, person("bob"));
    const forged = await app.request("/api/v1/auth/oidc/callback", post({ ...flow, state: "from-another-browser" }));
    assert.equal(forged.status, 401);
    assert.equal((await app.request("/api/v1/auth/oidc/callback", post(flow))).status, 200);
    assert.equal((await app.request("/api/v1/auth/oidc/callback", post(flow))).status, 401, "replay");
  });

  it("refuses an attacker's callback in a victim's browser that started its own sign-in", async () => {
    const app = await appWith();
    const attacker = await approved(app, person("mallory"));
    const victim = await approved(app, person("victim"));
    const res = await app.request("/api/v1/auth/oidc/callback", post({ query: attacker.query, state: victim.state }));
    assert.equal(res.status, 401);
    assert.equal(
      (await app.request("/api/v1/auth/oidc/callback", post(victim))).status,
      200,
      "the victim's own still works",
    );
  });

  it("refuses an expired pending login and a provider error", async () => {
    const app = await appWith();
    const flow = await approved(app, person("carol"));
    await db.sql`UPDATE oidc_logins SET created_at = now() - interval '11 minutes'`;
    assert.equal((await app.request("/api/v1/auth/oidc/callback", post(flow))).status, 401);
    const denied = await app.request(
      "/api/v1/auth/oidc/callback",
      post({ query: "error=access_denied&state=x", state: "x" }),
    );
    assert.equal(denied.status, 401);
  });

  it("never signs a new identity in to an existing account with the same username", async () => {
    await createUser(db.sql, { username: "dave", password: "correct horse battery" });
    const app = await appWith();
    const taken = await signIn(app, person("someone-else", { preferred_username: "dave" }));
    assert.equal(taken.status, 403);
    assert.match(taken.body.error ?? "", /taken/);
  });

  it("without autoCreate, only accounts an administrator linked may sign in", async () => {
    const app = await appWith({}, false);
    assert.equal((await signIn(app, person("erin"))).status, 403);
    await createUser(db.sql, { username: "erin", oidc: { issuer: idp.issuer, subject: "erin-sub" } });
    const linked = await signIn(app, { claims: { sub: "erin-sub", preferred_username: "whatever" } });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.user?.username, "erin");
  });

  it("applies allowedGroups, and adminGroups follows the provider at every sign-in", async () => {
    const app = await appWith({ allowedGroups: ["dev"], adminGroups: ["platform"] });
    assert.equal((await signIn(app, person("frank", { groups: ["sales"] }))).status, 403);
    assert.equal((await signIn(app, person("grace", { groups: ["dev"] }))).body.user?.isAdmin, false);
    assert.equal((await signIn(app, person("grace", { groups: ["platform"] }))).body.user?.isAdmin, true);
    assert.equal(
      (await signIn(app, person("grace", { groups: ["dev"] }))).body.user?.isAdmin,
      false,
      "removed at the provider",
    );
  });
});
