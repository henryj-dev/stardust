import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { it } from "node:test";
import { targetApi } from "./api.ts";
import { githubApp } from "./app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const SHA = "a".repeat(40);

interface Seen {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}

/** GitHub as far as the App uses it: installed on acme/private-app, acme/open is public, acme/hidden is private. */
function fakeGitHub(seen: Seen[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      auth,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const p = url.pathname;
    if (p === "/repos/acme/private-app/installation") return Response.json({ id: 77 });
    if (p.endsWith("/installation")) return new Response("{}", { status: 404 });
    if (p === "/app/installations/77/access_tokens")
      return Response.json(
        { token: "ghs_one-repo", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    if (p === "/repos/acme/open") return Response.json({ private: false, default_branch: "main" });
    if (p === "/repos/acme/private-app")
      return auth === "Bearer ghs_one-repo"
        ? Response.json({ private: true, default_branch: "main" })
        : new Response("{}", { status: 404 });
    if (p === "/repos/acme/private-app/commits/heads/main") return Response.json({ sha: SHA });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

it("signs its JWT with the App's key, and asks for a token for one repository, read-only", async () => {
  const seen: Seen[] = [];
  const app = githubApp({ appId: 42, privateKey: PEM, apiBaseUrl: "https://api.github.test", fetch: fakeGitHub(seen) });
  assert.equal(await app.tokenFor("acme/private-app"), "ghs_one-repo");
  const jwt = seen[0]?.auth.replace("Bearer ", "") ?? "";
  const [h, p, s] = jwt.split(".");
  assert.ok(
    createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s ?? "", "base64url")),
    "RS256 with the App's key",
  );
  const claims = JSON.parse(Buffer.from(p ?? "", "base64url").toString()) as { iss: string; iat: number; exp: number };
  assert.equal(claims.iss, "42");
  assert.ok(claims.exp - claims.iat <= 600, "within GitHub's ten minutes");
  const asked = seen.find((x) => x.path.endsWith("/access_tokens"));
  assert.deepEqual(asked?.body, { repositories: ["private-app"], permissions: { contents: "read", metadata: "read" } });
  await app.tokenFor("acme/private-app");
  assert.equal(seen.filter((x) => x.path.endsWith("/access_tokens")).length, 1, "kept until near its expiry");
});

it("clones a public repository without a token, and refuses a private one the App is not installed on", async () => {
  const app = githubApp({ appId: 42, privateKey: PEM, apiBaseUrl: "https://api.github.test", fetch: fakeGitHub() });
  assert.equal(await app.cloneToken("acme/private-app"), "ghs_one-repo");
  assert.equal(await app.cloneToken("acme/open"), null);
  await assert.rejects(app.cloneToken("acme/hidden"), /not installed on acme\/hidden/);
});

it("resolves commits with the repository's own token, and says a private repository needs the App", async () => {
  const app = githubApp({ appId: 42, privateKey: PEM, apiBaseUrl: "https://api.github.test", fetch: fakeGitHub() });
  const resolve = targetApi("https://api.github.test", app.tokenFor, fakeGitHub());
  assert.deepEqual(await resolve("acme/private-app", {}), { ref: "refs/heads/main", sha: SHA });
  await assert.rejects(resolve("acme/hidden", {}), /install the GitHub App on it/);
});

it("says how the App reads a repository: installed on it, public, or not at all", async () => {
  const app = githubApp({ appId: 42, privateKey: PEM, apiBaseUrl: "https://api.github.test", fetch: fakeGitHub() });
  assert.deepEqual(await app.access("acme/private-app"), { readable: "app", installation: "selected" });
  assert.deepEqual(await app.access("acme/open"), { readable: "public" });
  assert.deepEqual(await app.access("acme/hidden"), { readable: "none" });
});

it("says when the App is installed on all of the owner's repositories", async () => {
  const base = fakeGitHub();
  const everywhere = (async (input: string | URL | Request, init?: RequestInit) =>
    new URL(String(input)).pathname === "/repos/acme/private-app/installation"
      ? Response.json({ id: 77, repository_selection: "all" })
      : base(input, init)) as typeof fetch;
  const app = githubApp({ appId: 42, privateKey: PEM, apiBaseUrl: "https://api.github.test", fetch: everywhere });
  assert.deepEqual(await app.access("acme/private-app"), { readable: "app", installation: "all" });
});

it("does not take a failing GitHub for a repository it cannot read", async () => {
  const down = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  const app = githubApp({ appId: 42, privateKey: PEM, apiBaseUrl: "https://api.github.test", fetch: down });
  await assert.rejects(app.access("acme/private-app"), /503/);
});
