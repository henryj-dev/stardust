/**
 * The HTTP application against a real database: a signed push for a
 * registered project starts a run with its first jobs; anything unsigned,
 * oversized, ignored by policy or not matched by a trigger starts nothing.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createUser, ensureBootstrapAdmin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";
import { MAX_WEBHOOK_BYTES } from "./body.ts";

const SECRET = "webhook-secret";
const PASSWORD = "correct horse battery";
let db: TestDb;
let app: ReturnType<typeof createApp>;
let compareCalls: string[] = [];

before(async () => {
  db = await createTestDb();
  app = createApp(
    { version: "test" },
    {
      sql: db.sql,
      webhookSecret: SECRET,
      compare: async (repo, base, head) => {
        compareCalls.push(`${repo} ${base}...${head}`);
        return { files: [{ filename: "api/main.go" }] };
      },
    },
  );
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  admin.authorization = `Bearer ${await sessionFor("admin")}`;
});
after(async () => db.close());

const admin: Record<string, string> = { "content-type": "application/json" };
const sessionFor = async (username: string) => {
  const result = await signIn(db.sql, username, PASSWORD);
  if (!result.ok) throw new Error(`cannot sign in as ${username}`);
  return result.token;
};
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const push = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    head_commit: { message: "feat: x" },
    commits: [],
    ...over,
  });
const deliver = (body: string, headers: Record<string, string> = {}) =>
  app.request("/webhooks/github/demo", {
    method: "POST",
    body,
    headers: { "x-github-event": "push", "x-hub-signature-256": sign(body), ...headers },
  });
const runCount = async () => (await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM runs`)[0]?.n;

describe("admin API", () => {
  it("refuses a missing or wrong token", async () => {
    assert.equal((await app.request("/api/v1/projects/demo/runs")).status, 401);
    const wrong = await app.request("/api/v1/projects/demo/runs", { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
  });
  it("registers a project and rejects an invalid one with the reason", async () => {
    const ok = await app.request("/api/v1/projects/demo", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({
        name: "Demo",
        githubRepo: "acme/demo",
        pipelineDef: {
          on: { push: { branches: ["main"] } },
          jobs: { api: { pipeline: "C", component: "api", if: { paths: ["api/**"] } } },
        },
        components: [{ name: "api", pipeline: "C", context: "api", deployDir: "deploy/demo/api" }],
      }),
    });
    assert.equal(ok.status, 200);
    const bad = await app.request("/api/v1/projects/bad", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ components: [{ name: "x", pipeline: "C", deployDir: "/abs" }] }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /deployDir/);
  });
});

describe("sign-in and permissions", () => {
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

  it("signs in, reports the session, signs out", async () => {
    const res = await app.request("/api/v1/auth/login", json({ username: "admin", password: PASSWORD }));
    assert.equal(res.status, 200);
    const { token } = (await res.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    const session = (await (await app.request("/api/v1/session", { headers: auth })).json()) as {
      user: { username: string; isAdmin: boolean };
    };
    assert.deepEqual([session.user.username, session.user.isAdmin], ["admin", true]);
    assert.equal((await app.request("/api/v1/auth/logout", { method: "POST", headers: auth })).status, 200);
    assert.equal((await app.request("/api/v1/session", { headers: auth })).status, 401);
  });

  it("answers a wrong password and an unknown user alike", async () => {
    const wrong = await app.request("/api/v1/auth/login", json({ username: "admin", password: "wrong password!" }));
    const unknown = await app.request("/api/v1/auth/login", json({ username: "nobody", password: PASSWORD }));
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
    assert.equal((await app.request("/api/v1/auth/login", json({ username: "admin" }))).status, 400);
  });

  it("viewers read their project; outsiders see no project; neither administers", async () => {
    await createUser(db.sql, { username: "viewer", password: PASSWORD });
    await createUser(db.sql, { username: "outsider", password: PASSWORD });
    const grant = await app.request("/api/v1/projects/demo/members/viewer", {
      ...json({ role: "viewer" }, admin),
      method: "PUT",
    });
    assert.equal(grant.status, 200);
    const viewer = { authorization: `Bearer ${await sessionFor("viewer")}` };
    const outsider = { authorization: `Bearer ${await sessionFor("outsider")}` };

    assert.equal((await app.request("/api/v1/projects/demo/runs", { headers: viewer })).status, 200);
    assert.equal((await app.request("/api/v1/projects/demo/runs", { headers: outsider })).status, 404);
    const put = { method: "PUT", body: "{}", headers: { ...viewer, "content-type": "application/json" } };
    assert.equal((await app.request("/api/v1/projects/demo", put)).status, 403);
    assert.equal((await app.request("/api/v1/users", json({ username: "x", password: PASSWORD }, viewer))).status, 403);
    assert.equal(
      (
        await app.request("/api/v1/projects/demo/members/outsider", {
          ...json({ role: "maintainer" }, viewer),
          method: "PUT",
        })
      ).status,
      403,
    );
  });

  it("administrators create users; bad input is refused with the reason", async () => {
    const ok = await app.request("/api/v1/users", json({ username: "dev", password: PASSWORD }, admin));
    assert.equal(ok.status, 201);
    const short = await app.request("/api/v1/users", json({ username: "dev2", password: "short" }, admin));
    assert.equal(short.status, 400);
    assert.match(((await short.json()) as { error: string }).error, /at least 12/);
    const role = await app.request("/api/v1/projects/demo/members/dev", {
      ...json({ role: "owner" }, admin),
      method: "PUT",
    });
    assert.equal(role.status, 400);
  });
});

describe("API tokens", () => {
  const post = (body: unknown, auth: string) => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { authorization: auth, "content-type": "application/json" },
  });

  it("are shown once, act as their user with that user's roles, and stop working when revoked", async () => {
    const res = await app.request("/api/v1/tokens", post({ name: "ci", expiresInDays: 30 }, admin.authorization ?? ""));
    assert.equal(res.status, 201);
    const { token, id } = (await res.json()) as { token: string; id: string };
    assert.match(token, /^sdt_/);
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await app.request("/api/v1/projects/demo/runs", { headers: auth })).status, 200);
    const listed = await (await app.request("/api/v1/tokens", { headers: auth })).text();
    assert.ok(listed.includes('"name":"ci"') && !listed.includes(token), "listed without the secret");
    assert.equal((await app.request("/api/v1/tokens", post({ name: "ci" }, auth.authorization))).status, 409);
    assert.equal((await app.request(`/api/v1/tokens/${id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await app.request("/api/v1/projects/demo/runs", { headers: auth })).status, 401);
  });

  it("one user cannot see or revoke another's token", async () => {
    const mine = (await (
      await app.request("/api/v1/tokens", post({ name: "mine" }, admin.authorization ?? ""))
    ).json()) as {
      id: string;
      token: string;
    };
    const other = `Bearer ${await sessionFor("outsider")}`;
    assert.equal(
      (await app.request(`/api/v1/tokens/${mine.id}`, { method: "DELETE", headers: { authorization: other } })).status,
      404,
    );
    const theirs = await (await app.request("/api/v1/tokens", { headers: { authorization: other } })).text();
    assert.ok(!theirs.includes(mine.id));
    assert.equal(
      (await app.request("/api/v1/session", { headers: { authorization: `Bearer ${mine.token}` } })).status,
      200,
    );
  });

  it("refuses bad names and lifetimes; an expired token does not authenticate", async () => {
    assert.equal((await app.request("/api/v1/tokens", post({ name: "" }, admin.authorization ?? ""))).status, 400);
    assert.equal(
      (await app.request("/api/v1/tokens", post({ name: "x", expiresInDays: 0 }, admin.authorization ?? ""))).status,
      400,
    );
    const { token } = (await (
      await app.request("/api/v1/tokens", post({ name: "old", expiresInDays: 1 }, admin.authorization ?? ""))
    ).json()) as {
      token: string;
    };
    await db.sql`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE name = 'old'`;
    assert.equal((await app.request("/api/v1/session", { headers: { authorization: `Bearer ${token}` } })).status, 401);
  });
});

describe("every API route is guarded", () => {
  // Read from the router itself, so a route added later without a check fails
  // here. Routes open to any signed-in user must be listed with the reason.
  // Own-account routes: every signed-in user may use them, on their own things only.
  const SIGNED_IN = new Set([
    "GET /api/v1/session",
    "POST /api/v1/auth/logout",
    "GET /api/v1/tokens",
    "POST /api/v1/tokens",
    "DELETE /api/v1/tokens/:tokenId",
  ]);
  const PUBLIC = new Set([
    "POST /api/v1/auth/login",
    "GET /api/v1/auth/methods",
    "POST /api/v1/auth/oidc/start",
    "POST /api/v1/auth/oidc/callback",
  ]);
  const routes = () => [
    ...new Set(
      app.routes.filter((r) => r.path.startsWith("/api/v1/") && r.method !== "ALL").map((r) => `${r.method} ${r.path}`),
    ),
  ];
  const fill = (path: string) =>
    path
      .replace(":id", "demo")
      .replace(":username", "outsider")
      .replace(":tokenId", "00000000-0000-0000-0000-000000000000");

  it("the list is not empty and holds the routes we know of", () => {
    const all = routes();
    assert.ok(all.length >= 8, all.join("\n"));
    assert.ok(all.includes("PUT /api/v1/projects/:id"));
  });

  it("without a session, every route but sign-in answers 401", async () => {
    for (const route of routes()) {
      if (PUBLIC.has(route)) continue;
      const [method, path] = route.split(" ") as [string, string];
      const res = await app.request(fill(path), { method, body: method === "GET" ? null : "{}" });
      assert.equal(res.status, 401, route);
    }
  });

  it("a signed-in user with no role is refused everywhere else (403, or 404 for a project)", async () => {
    const outsider = { authorization: `Bearer ${await sessionFor("outsider")}`, "content-type": "application/json" };
    for (const route of routes()) {
      if (PUBLIC.has(route) || SIGNED_IN.has(route)) continue;
      const [method, path] = route.split(" ") as [string, string];
      const res = await app.request(fill(path), { method, headers: outsider, body: method === "GET" ? null : "{}" });
      assert.ok(res.status === 403 || res.status === 404, `${route} answered ${res.status}`);
    }
  });
});

describe("webhooks", () => {
  it("a signed push starts a run with changed paths from compare", async () => {
    compareCalls = [];
    const res = await deliver(push());
    assert.equal(res.status, 201);
    const { runId } = (await res.json()) as { runId: string };
    assert.deepEqual(compareCalls, [`acme/demo ${"a".repeat(40)}...${"b".repeat(40)}`]);
    const jobs = await db.sql<
      { name: string; status: string }[]
    >`SELECT name, status FROM jobs WHERE run_id = ${runId}`;
    assert.deepEqual(
      jobs.map((j) => ({ ...j })),
      [{ name: "api", status: "queued" }],
    );
    const runs = await app.request("/api/v1/projects/demo/runs", { headers: admin });
    assert.equal(((await runs.json()) as { runs: unknown[] }).runs.length, 1);
  });

  it("refuses a bad signature, a missing one and an unknown project without starting anything", async () => {
    const before = await runCount();
    const body = push();
    assert.equal((await deliver(body, { "x-hub-signature-256": "sha256=00" })).status, 401);
    assert.equal(
      (await app.request("/webhooks/github/demo", { method: "POST", body, headers: { "x-github-event": "push" } }))
        .status,
      401,
    );
    assert.equal((await app.request("/webhooks/github/nope", { method: "POST", body })).status, 404);
    assert.equal(await runCount(), before);
  });

  it("refuses an oversized body, even without Content-Length", async () => {
    const big = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const res = await app.request("/webhooks/github/demo", {
      method: "POST",
      body: stream,
      headers: { "x-github-event": "push", "x-hub-signature-256": sign(big) },
      // Node needs duplex for a streamed request body.
      duplex: "half",
    });
    assert.equal(res.status, 413);
  });

  it("answers ping, and ignores skip-ci pushes and branches without a trigger", async () => {
    const before = await runCount();
    assert.equal((await deliver("{}", { "x-github-event": "ping" })).status, 200);
    const skip = await deliver(push({ head_commit: { message: "docs [skip ci]" } }));
    assert.equal(skip.status, 202);
    const other = await deliver(push({ ref: "refs/heads/feature" }));
    assert.equal(other.status, 202);
    assert.match(((await other.json()) as { reason: string }).reason, /no trigger/);
    assert.equal(await runCount(), before);
  });

  it("a push whose net change misses the job's path filter skips the job", async () => {
    const quiet = createApp(
      { version: "test" },
      {
        sql: db.sql,
        webhookSecret: SECRET,
        compare: async () => ({ files: [{ filename: "README.md" }] }),
      },
    );
    const body = push();
    const res = await quiet.request("/webhooks/github/demo", {
      method: "POST",
      body,
      headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
    });
    const { runId } = (await res.json()) as { runId: string };
    const [job] = await db.sql<{ status: string }[]>`SELECT status FROM jobs WHERE run_id = ${runId}`;
    assert.equal(job?.status, "skipped");
    const [run] = await db.sql<{ status: string }[]>`SELECT status FROM runs WHERE id = ${runId}`;
    assert.equal(run?.status, "success");
  });
});
