import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { GitCliRepo } from "./git-cli.ts";
import { appJwt, installationTokens, repoFromUrl } from "./github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

describe("the App's JWT", () => {
  it("is RS256, signed by the App's key, issued by the App, valid ten minutes from a minute ago", () => {
    const jwt = appJwt(42, PEM, 1_000_000);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(decode(payload), { iat: 999_940, exp: 1_000_540, iss: "42" });
    assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
  });
});

describe("which repository a URL names", () => {
  it("reads owner/name from a GitHub https URL, and nothing else", () => {
    assert.equal(repoFromUrl("https://github.com/acme/deploy.git"), "acme/deploy");
    assert.equal(repoFromUrl("https://github.com/acme/deploy"), "acme/deploy");
    assert.equal(repoFromUrl("https://github.com/acme/my.deploy.git"), "acme/my.deploy");
    for (const url of [
      "https://gitea.example.com/acme/deploy.git",
      "http://github.com/acme/deploy",
      "https://github.com/acme",
      "/srv/deploy.git",
    ]) {
      assert.equal(repoFromUrl(url), null, url);
    }
  });
});

/** A GitHub API stand-in that issues tokens expiring an hour after `clock`. */
function github(clock: { t: number }) {
  const calls: Array<{ method: string; path: string; body: unknown; jwt: Record<string, unknown> }> = [];
  let issued = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://api.test", "");
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const [, payload] = auth.replace("Bearer ", "").split(".") as [string, string];
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      jwt: decode(payload),
    });
    if (path === "/repos/acme/deploy/installation") return Response.json({ id: 77 });
    if (path === "/app/installations/77/access_tokens") {
      issued++;
      return Response.json(
        { token: `ghs_${issued}`, expires_at: new Date((clock.t + 3600) * 1000).toISOString() },
        { status: 201 },
      );
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("installation tokens", () => {
  it("finds the installation, asks for a token narrowed to the repository and contents:write, and reuses it", async () => {
    const clock = { t: 2_000_000 };
    const { calls, fetchFn } = github(clock);
    const tokens = installationTokens({
      appId: 42,
      privateKey: PEM,
      repo: "acme/deploy",
      apiBaseUrl: "https://api.test",
      fetch: fetchFn,
      now: () => clock.t,
    });
    assert.equal(await tokens(), "ghs_1");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ["GET /repos/acme/deploy/installation", "POST /app/installations/77/access_tokens"],
    );
    assert.deepEqual(calls[1]?.body, { repositories: ["deploy"], permissions: { contents: "write" } });
    assert.equal(calls[0]?.jwt.iss, "42");
    clock.t += 3000; // 50 minutes later, ten minutes left: still good
    assert.equal(await tokens(), "ghs_1");
    assert.equal(calls.length, 2);
  });

  it("renews five minutes before expiry, without looking the installation up again", async () => {
    const clock = { t: 2_000_000 };
    const { calls, fetchFn } = github(clock);
    const tokens = installationTokens({
      appId: 42,
      privateKey: PEM,
      repo: "acme/deploy",
      apiBaseUrl: "https://api.test",
      fetch: fetchFn,
      now: () => clock.t,
    });
    await tokens();
    clock.t += 3600 - 299;
    assert.equal(await tokens(), "ghs_2");
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/repos/acme/deploy/installation", "/app/installations/77/access_tokens", "/app/installations/77/access_tokens"],
    );
  });

  it("concurrent callers share one request", async () => {
    const clock = { t: 2_000_000 };
    const { calls, fetchFn } = github(clock);
    const tokens = installationTokens({
      appId: 42,
      privateKey: PEM,
      repo: "acme/deploy",
      apiBaseUrl: "https://api.test",
      fetch: fetchFn,
      now: () => clock.t,
    });
    assert.deepEqual(await Promise.all([tokens(), tokens(), tokens()]), ["ghs_1", "ghs_1", "ghs_1"]);
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  });

  it("says when the App is not installed on the repository, and refuses a bad key at once", async () => {
    const clock = { t: 2_000_000 };
    const { fetchFn } = github(clock);
    const tokens = installationTokens({
      appId: 42,
      privateKey: PEM,
      repo: "acme/other",
      apiBaseUrl: "https://api.test",
      fetch: fetchFn,
      now: () => clock.t,
    });
    await assert.rejects(tokens(), /answered 404: is the App installed on it\?/);
    assert.throws(() => installationTokens({ appId: 42, privateKey: "not a key", repo: "acme/deploy" }));
  });
});

describe("a token function reaches git", () => {
  it("is asked before each network command and sent as the credential header", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? "");
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    let n = 0;
    const repo = new GitCliRepo({
      url: `http://127.0.0.1:${port}/acme/deploy.git`,
      branch: "main",
      token: async () => `tok${++n}`,
    });
    try {
      await assert.rejects(repo.headSha());
      await assert.rejects(repo.headSha());
    } finally {
      await repo.close();
      server.close();
    }
    const basic = (t: string) => `Basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}`;
    assert.ok(seen.includes(basic("tok1")), seen.join(" | "));
    assert.ok(seen.includes(basic("tok2")), "a later command asks again");
    assert.ok(!seen.some((h) => h === ""), "no request went without the header");
    assert.equal(n, 2, "asked once per network command, not for local ones");
  });
});
