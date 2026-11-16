/**
 * Single sign-on sessions ending with the provider's, both ways, and the
 * provider's second step: back-channel logout, signing out at the provider,
 * a required `amr`, and confirming it is you by signing in again.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createOidc } from "@stardust/plugin-identity-oidc";
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

async function appWith(requireAmr: string[] = []) {
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
      resolveTarget: async () => ({ ref: "", sha: "" }),
      oidc: {
        client: async () => client,
        redirectUri: REDIRECT,
        displayName: "SSO",
        rules: {},
        autoCreate: true,
        requireAmr,
      },
    },
  );
}
type App = Awaited<ReturnType<typeof appWith>>;
const json = { "content-type": "application/json" };

async function signInVia(app: App, issued: Issued, reauth = false) {
  const start = (await (
    await app.request("/api/v1/auth/oidc/start", { method: "POST", headers: json, body: JSON.stringify({ reauth }) })
  ).json()) as { url: string; state: string };
  const { code, state } = idp.approve(start.url, issued);
  const res = await app.request("/api/v1/auth/oidc/callback", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ query: `code=${code}&state=${state}`, state: start.state }),
  });
  return { res, url: new URL(start.url) };
}
const now = () => Math.floor(Date.now() / 1000);
const claims = (extra: Record<string, unknown> = {}) => ({
  claims: { sub: "ada-sub", preferred_username: "ada", sid: "idp-session-1", amr: ["pwd"], auth_time: now(), ...extra },
});
const backchannel = (app: App, token: string) =>
  app.request("/api/v1/auth/oidc/backchannel-logout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ logout_token: token }).toString(),
  });
const sessionOk = async (app: App, token: string) =>
  (await app.request("/api/v1/session", { headers: { authorization: `Bearer ${token}` } })).status === 200;

describe("back-channel logout", () => {
  it("ends the session the provider names, once per token, and refuses tokens that do not check out", async () => {
    const app = await appWith();
    const { res } = await signInVia(app, claims());
    const { token } = (await res.json()) as { token: string };
    const other = (await (await signInVia(app, claims({ sid: "idp-session-2" }))).res.json()) as { token: string };
    for (const bad of [
      await idp.logoutToken({ sid: "idp-session-1" }, { aud: "someone-else" }),
      await idp.logoutToken({ sid: "idp-session-1" }, { nonce: "n" }),
      await idp.logoutToken({ sid: "idp-session-1" }, { noEvent: true }),
      await idp.logoutToken({ sid: "idp-session-1" }, { foreignKey: true }),
      await idp.logoutToken({}),
      "not-a-jwt",
    ]) {
      assert.equal((await backchannel(app, bad)).status, 400);
    }
    assert.equal(await sessionOk(app, token), true, "nothing ended yet");
    const good = await idp.logoutToken({ sid: "idp-session-1" });
    const ended = await backchannel(app, good);
    assert.equal(ended.status, 200);
    assert.equal(ended.headers.get("cache-control"), "no-store");
    assert.equal(await sessionOk(app, token), false);
    assert.equal(await sessionOk(app, other.token), true, "another provider session stays");
    assert.equal((await backchannel(app, good)).status, 400, "a token is accepted once");
    assert.equal((await backchannel(app, await idp.logoutToken({ sub: "ada-sub" }))).status, 200);
    assert.equal(await sessionOk(app, other.token), false, "by subject: every session of the person");
  });
});

describe("signing out", () => {
  it("sends a single sign-on session on to the provider's logout page with the ID token", async () => {
    const app = await appWith();
    const { token } = (await (await signInVia(app, claims())).res.json()) as { token: string };
    const res = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const { redirect } = (await res.json()) as { redirect: string };
    const url = new URL(redirect);
    assert.equal(url.origin + url.pathname, `${idp.issuer}/logout`);
    assert.ok(url.searchParams.get("id_token_hint"));
    assert.equal(url.searchParams.get("post_logout_redirect_uri"), "https://stardust.example.com/login");
    assert.equal(await sessionOk(app, token), false);
  });
});

describe("the provider's second step", () => {
  it("can be required: a sign-in without the amr is refused", async () => {
    const app = await appWith(["otp"]);
    assert.equal((await signInVia(app, claims({ amr: ["pwd"] }))).res.status, 403);
    assert.equal((await signInVia(app, claims({ amr: ["pwd", "otp"] }))).res.status, 200);
  });

  it("confirming it is you signs in again at the provider, and only a fresh sign-in counts", async () => {
    const app = await appWith();
    const stale = await signInVia(app, claims({ auth_time: now() - 3600 }), true);
    assert.equal(stale.url.searchParams.get("prompt"), "login");
    assert.equal(stale.url.searchParams.get("max_age"), "0");
    assert.equal(stale.res.status, 401, "the provider did not sign the person in again");
    const fresh = await signInVia(app, claims(), true);
    assert.equal(fresh.res.status, 200);
  });
});
