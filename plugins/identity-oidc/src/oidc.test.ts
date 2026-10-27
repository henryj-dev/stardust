import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { plugin } from "./index.ts";
import { createOidc, decideAccess, type Identity, type Oidc } from "./oidc.ts";
import { FakeProvider, type Issued } from "./testing.ts";

const CLIENT = { clientId: "stardust", clientSecret: "client-secret" };
const REDIRECT = "https://stardust.example.com/login/oidc/callback";
let idp: FakeProvider;
let oidc: Oidc;

before(async () => {
  idp = await FakeProvider.start(CLIENT);
  oidc = await createOidc({ issuer: idp.issuer, ...CLIENT, redirectUri: REDIRECT, allowInsecureRequests: true });
});
after(async () => idp.close());

/** Runs the whole flow as a browser would, with the provider issuing `issued`. */
async function signIn(issued: Issued = {}, mangle: (callback: URL) => void = () => {}): Promise<Identity> {
  const { url, pending } = await oidc.start();
  const { code, state } = idp.approve(url, issued);
  const callback = new URL(REDIRECT);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  mangle(callback);
  return oidc.finish(callback.href, pending);
}

describe("the authorization request", () => {
  it("uses PKCE S256, a state and a nonce, each fresh per sign-in", async () => {
    const a = new URL((await oidc.start()).url);
    const b = new URL((await oidc.start()).url);
    assert.equal(a.searchParams.get("code_challenge_method"), "S256");
    assert.equal(a.searchParams.get("redirect_uri"), REDIRECT);
    assert.match(a.searchParams.get("scope") ?? "", /^openid /);
    for (const p of ["state", "nonce", "code_challenge"]) {
      assert.ok(a.searchParams.get(p));
      assert.notEqual(a.searchParams.get(p), b.searchParams.get(p), p);
    }
  });
});

describe("the callback", () => {
  it("returns who signed in", async () => {
    const who = await signIn({
      claims: {
        sub: "u-42",
        preferred_username: "ada",
        email: "ada@example.com",
        email_verified: true,
        groups: ["dev", 7],
      },
    });
    assert.deepEqual(who, {
      issuer: idp.issuer,
      subject: "u-42",
      username: "ada",
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      groups: ["dev"],
    });
  });

  it("falls back to the email's local part for the username", async () => {
    assert.equal((await signIn({ claims: { email: "grace@example.com" } })).username, "grace");
  });

  const refused: Array<[string, Issued, (u: URL) => void]> = [
    ["a different state", {}, (u) => u.searchParams.set("state", "forged")],
    ["an ID token for another client", { tamper: { aud: "someone-else" } }, () => {}],
    ["an ID token from another issuer", { tamper: { iss: "https://evil.example" } }, () => {}],
    ["a replayed nonce", { tamper: { nonce: "old-nonce" } }, () => {}],
    ["an expired ID token", { tamper: { expired: true } }, () => {}],
    ["a token signed with a key the provider does not publish", { tamper: { foreignKey: true } }, () => {}],
    ["a callback on another path", {}, (u) => (u.pathname = "/elsewhere")],
  ];
  for (const [what, issued, mangle] of refused) {
    it(`refuses ${what}`, async () => {
      await assert.rejects(signIn(issued, mangle));
    });
  }

  it("refuses to reuse an authorization code", async () => {
    const { url, pending } = await oidc.start();
    const { code, state } = idp.approve(url);
    const callback = `${REDIRECT}?code=${code}&state=${state}`;
    await oidc.finish(callback, pending);
    await assert.rejects(oidc.finish(callback, pending));
  });
});

describe("decideAccess", () => {
  const who = (groups: string[]): Identity => ({
    issuer: "i",
    subject: "s",
    username: "u",
    email: null,
    emailVerified: false,
    name: null,
    groups,
  });
  it("allows everyone without allowedGroups, only members with it; admin groups imply access", () => {
    assert.deepEqual(decideAccess(who([]), {}), { allowed: true, isAdmin: false });
    assert.deepEqual(decideAccess(who(["dev"]), { allowedGroups: ["ops"] }), { allowed: false, isAdmin: false });
    assert.deepEqual(decideAccess(who(["ops"]), { allowedGroups: ["ops"] }), { allowed: true, isAdmin: false });
    assert.deepEqual(decideAccess(who(["root"]), { allowedGroups: ["ops"], adminGroups: ["root"] }), {
      allowed: true,
      isAdmin: true,
    });
  });
});

describe("configuration", () => {
  const ok = { issuer: "https://id.example.com", clientId: "c", clientSecret: { env: "X" } };
  it("accepts a complete section and names each problem otherwise", () => {
    assert.deepEqual(plugin.validateConfig(ok), []);
    assert.deepEqual(plugin.validateConfig({ ...ok, issuer: "http://id.example.com" }), [
      "issuer must be an https URL",
    ]);
    assert.deepEqual(plugin.validateConfig({ ...ok, extra: 1 }), ['unknown key "extra"']);
    assert.deepEqual(plugin.validateConfig({ ...ok, adminGroups: "root" }), ["adminGroups must be a list of names"]);
  });
});
