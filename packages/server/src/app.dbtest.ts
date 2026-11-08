/**
 * The HTTP application against a real database: sign-in and permissions, the
 * admin API, and runs, which start only when someone asks for one.
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createUser, ensureBootstrapAdmin, putProject, signIn, startRun } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import type { BuildLog, BuildLogReader } from "@stardust/plugin-builder-buildkit";
import { MemoryRepo } from "@stardust/plugin-gitops-git/testing";
import { createApp } from "./app.ts";
import { fakeCodec } from "./env-testing.ts";
import { type PullTarget, TargetError } from "./source.ts";

const PASSWORD = "correct horse battery";
let db: TestDb;
let app: ReturnType<typeof createApp>;
let targetCalls: Array<{ repo: string; target: PullTarget }> = [];
// A source host with a default branch "main" at f…f and a tag v1 at c…c.
const resolveTarget = async (repo: string, target: PullTarget) => {
  targetCalls.push({ repo, target });
  if ("tag" in target) {
    if (target.tag !== "v1") throw new TargetError(`tag ${target.tag} was not found`, true);
    return { ref: "refs/tags/v1", sha: "c".repeat(40) };
  }
  if ("sha" in target) return { ref: "refs/heads/main", sha: target.sha };
  if ("branch" in target && target.branch === "down") throw new TargetError("the source host answered 503", false);
  return { ref: `refs/heads/${"branch" in target ? target.branch : "main"}`, sha: "f".repeat(40) };
};

before(async () => {
  db = await createTestDb();
  app = createApp(
    { version: "test" },
    {
      sql: db.sql,
      resolveTarget,
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

  it("refuses an oversized request body before reading it", async () => {
    const res = await app.request("/api/v1/auth/login", json({ username: "admin", password: "x".repeat(100_000) }));
    assert.equal(res.status, 413);
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

describe("reading projects and users", () => {
  it("lists each project with its newest run, without jobs, or null when it has none", async () => {
    const base = { githubRepo: "acme/listed", pipelineDef: null, metadata: {} };
    const components = [{ name: "api", pipeline: "C" as const, deployDir: "deploy/listed/api" }];
    await putProject(db.sql, { ...base, id: "listed", name: "Listed", components });
    await putProject(db.sql, { ...base, id: "listed-idle", name: "Idle", components });
    const run = (sha: string) =>
      startRun(db.sql, {
        projectId: "listed",
        event: "manual",
        trigger: "manual",
        ref: "refs/heads/main",
        sha,
        def: { jobs: { api: { pipeline: "C", component: "api" } } },
        changedPaths: null,
        requestedBy: "admin",
      });
    await run("1".repeat(40));
    const newest = await run("2".repeat(40));
    const body = (await (await app.request("/api/v1/projects", { headers: admin })).json()) as {
      projects: { id: string; lastRun: { id: string; sha: string; jobs?: unknown } | null }[];
    };
    const listed = body.projects.find((p) => p.id === "listed");
    assert.equal(listed?.lastRun?.id, newest);
    assert.equal(listed?.lastRun?.sha, "2".repeat(40));
    assert.equal(listed?.lastRun?.jobs, undefined);
    assert.equal(body.projects.find((p) => p.id === "listed-idle")?.lastRun, null);
  });

  it("administrators list every project; others only their memberships; a project reads back as it was put", async () => {
    const all = (await (await app.request("/api/v1/projects", { headers: admin })).json()) as {
      projects: { id: string }[];
    };
    assert.ok(all.projects.some((p) => p.id === "demo"));
    const viewer = { authorization: `Bearer ${await sessionFor("viewer")}` };
    const mine = (await (await app.request("/api/v1/projects", { headers: viewer })).json()) as {
      projects: { id: string }[];
    };
    assert.deepEqual(
      mine.projects.map((p) => p.id),
      ["demo"],
    );
    const outsider = { authorization: `Bearer ${await sessionFor("outsider")}` };
    const none = (await (await app.request("/api/v1/projects", { headers: outsider })).json()) as {
      projects: unknown[];
    };
    assert.deepEqual(none.projects, []);
    const one = (await (await app.request("/api/v1/projects/demo", { headers: viewer })).json()) as {
      githubRepo: string;
      components: { deployDir: string }[];
    };
    assert.equal(one.githubRepo, "acme/demo");
    assert.equal(one.components[0]?.deployDir, "deploy/demo/api");
  });

  it("administrators list users with roles and identities, never password hashes", async () => {
    const res = await app.request("/api/v1/users", { headers: admin });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!text.includes("scrypt$"), "no hash");
    const users = (JSON.parse(text) as { users: { username: string; hasPassword: boolean; roles: unknown[] }[] }).users;
    const viewer = users.find((u) => u.username === "viewer");
    assert.deepEqual(viewer?.roles, [{ projectId: "demo", role: "viewer" }]);
    assert.equal(viewer?.hasPassword, true);
  });
});

describe("changing users", () => {
  const patch = (username: string, body: unknown) =>
    app.request(`/api/v1/users/${username}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { ...admin, "content-type": "application/json" },
    });

  it("links an OpenID identity, refuses one that belongs to someone else, and unlinks", async () => {
    await createUser(db.sql, { username: "linked", password: PASSWORD });
    await createUser(db.sql, { username: "other", oidc: { issuer: "https://id.example", subject: "taken" } });
    assert.equal((await patch("linked", { oidc: { issuer: "https://id.example", subject: "s-1" } })).status, 200);
    assert.equal((await patch("linked", { oidc: { issuer: "https://id.example", subject: "taken" } })).status, 409);
    const users = (await (await app.request("/api/v1/users", { headers: admin })).json()) as {
      users: { username: string; oidc: unknown }[];
    };
    assert.deepEqual(users.users.find((u) => u.username === "linked")?.oidc, {
      issuer: "https://id.example",
      subject: "s-1",
    });
    assert.equal((await patch("linked", { oidc: null })).status, 200);
  });

  it("disabling a user ends their sessions; unknown fields and users are refused", async () => {
    await createUser(db.sql, { username: "leaving", password: PASSWORD });
    const token = await sessionFor("leaving");
    assert.equal((await patch("leaving", { disabled: true })).status, 200);
    assert.equal((await app.request("/api/v1/session", { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await patch("leaving", { role: "god" })).status, 400);
    assert.equal((await patch("nobody-at-all", { disabled: true })).status, 404);
  });

  it("never leaves the installation without an enabled administrator", async () => {
    // admin may be the only one: demoting or disabling them is refused.
    const others = (await (await app.request("/api/v1/users", { headers: admin })).json()) as {
      users: { username: string; isAdmin: boolean; disabled: boolean }[];
    };
    const enabledAdmins = others.users.filter((u) => u.isAdmin && !u.disabled).map((u) => u.username);
    assert.deepEqual(enabledAdmins, ["admin"]);
    assert.equal((await patch("admin", { isAdmin: false })).status, 409);
    assert.equal((await patch("admin", { disabled: true })).status, 409);
    await createUser(db.sql, { username: "second-admin", password: PASSWORD, isAdmin: true });
    assert.equal((await patch("second-admin", { isAdmin: false })).status, 200, "allowed while admin remains");
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
    // Lists only what the caller may read (tested in "reading projects and users").
    "GET /api/v1/projects",
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
      .replace(":tokenId", "00000000-0000-0000-0000-000000000000")
      .replace(":runId", "00000000-0000-0000-0000-000000000000")
      .replace(":job", "api")
      .replace(":layer", "_shared");

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

describe("manual runs", () => {
  const pull = (project: string, body: unknown, headers: Record<string, string> = admin) =>
    app.request(`/api/v1/projects/${project}/runs`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { ...headers, "content-type": "application/json" },
    });
  const jobsOf = async (runId: string) =>
    Object.fromEntries(
      (await db.sql<{ name: string; status: string }[]>`SELECT name, status FROM jobs WHERE run_id = ${runId}`).map(
        (j) => [j.name, j.status],
      ),
    );

  it("builds the default branch's head with every job, ignoring triggers and path filters, and records who asked", async () => {
    targetCalls = [];
    const res = await pull("demo", {});
    assert.equal(res.status, 201);
    const body = (await res.json()) as { runId: string; ref: string; sha: string };
    assert.deepEqual([body.ref, body.sha], ["refs/heads/main", "f".repeat(40)]);
    assert.deepEqual(targetCalls, [{ repo: "acme/demo", target: {} }]);
    // demo's only job has a path filter (api/**); a manual run has no changed paths and runs it anyway.
    assert.deepEqual(await jobsOf(body.runId), { api: "queued" });
    const [run] = await db.sql<{ event: string; trigger: string; requested_by: string }[]>`
      SELECT event, trigger, requested_by FROM runs WHERE id = ${body.runId}`;
    assert.deepEqual(run, { event: "manual", trigger: "manual", requested_by: "admin" });
    const listed = (await (await app.request("/api/v1/projects/demo/runs", { headers: admin })).json()) as {
      runs: Array<{ id: string; requestedBy: string | null }>;
    };
    assert.equal(listed.runs.find((r) => r.id === body.runId)?.requestedBy, "admin");
  });

  it("builds a tag or a commit; a branch the definition's `on` block does not name still runs", async () => {
    const tag = (await (await pull("demo", { tag: "v1" })).json()) as { ref: string; sha: string };
    assert.deepEqual([tag.ref, tag.sha], ["refs/tags/v1", "c".repeat(40)]);
    const commit = (await (await pull("demo", { sha: "d".repeat(40) })).json()) as { sha: string };
    assert.equal(commit.sha, "d".repeat(40));
    const feature = await pull("demo", { branch: "feature" });
    assert.equal(feature.status, 201);
  });

  it("refuses a bad target before asking the source host, and reports what the host said", async () => {
    targetCalls = [];
    for (const body of [
      { branch: "main", tag: "v1" },
      { ref: "main" },
      { sha: "abc123" },
      { branch: "../x" },
      { branch: "-x" },
      { tag: "a b" },
      { branch: 7 },
    ]) {
      assert.equal((await pull("demo", body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(targetCalls, [], "the source host was not asked");
    const missing = await pull("demo", { tag: "v9" });
    assert.equal(missing.status, 422);
    assert.match(((await missing.json()) as { error: string }).error, /v9 was not found/);
    assert.equal((await pull("demo", { branch: "down" })).status, 502);
  });

  it("needs write access: a viewer is refused, an outsider learns nothing", async () => {
    const before = await runCount();
    const viewer = { authorization: `Bearer ${await sessionFor("viewer")}` };
    assert.equal((await pull("demo", {}, viewer)).status, 403);
    const outsider = { authorization: `Bearer ${await sessionFor("outsider")}` };
    assert.equal((await pull("demo", {}, outsider)).status, 404);
    assert.equal((await pull("nope", {})).status, 404);
    assert.equal(await runCount(), before);
  });

  it("an older client's webhookKind is accepted and dropped; the project is delivered by asking", async () => {
    const put = await app.request("/api/v1/projects/quiet", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({
        githubRepo: "acme/quiet",
        webhookKind: "off",
        components: [{ name: "app", pipeline: "C", deployDir: "deploy/quiet/app" }],
      }),
    });
    assert.equal(put.status, 200);
    assert.equal("webhookKind" in ((await put.json()) as object), false);
    const pulled = (await (await pull("quiet", {})).json()) as { runId: string };
    assert.deepEqual(await jobsOf(pulled.runId), { app: "queued" });
  });
});

describe("no webhooks", () => {
  it("a signed GitHub delivery finds no route and starts nothing", async () => {
    const before = await runCount();
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "b".repeat(40),
      repository: { full_name: "acme/demo" },
    });
    const signature = `sha256=${createHmac("sha256", "any-secret").update(body).digest("hex")}`;
    for (const path of ["/webhooks/github/demo", "/webhook/github/acme/demo"]) {
      const res = await app.request(path, {
        method: "POST",
        body,
        headers: { "x-github-event": "push", "x-hub-signature-256": signature },
      });
      assert.equal(res.status, 404, path);
    }
    assert.equal(await runCount(), before);
  });

  it("there is no plan endpoint either", () => {
    assert.equal(
      app.routes.some((r) => r.path.includes("/plan") || r.path.startsWith("/webhook")),
      false,
    );
  });
});

describe("one run and its build logs", () => {
  // A cluster stand-in: per job name, what the build pod holds.
  const pods = new Map<string, BuildLog | "throw">();
  const signals: AbortSignal[] = [];
  const buildLogs: BuildLogReader = async ({ jobName, signal }) => {
    signals.push(signal);
    const found = pods.get(jobName) ?? { state: "none" };
    if (found === "throw") throw new Error("connect ECONNREFUSED");
    return found;
  };
  let logsApp: ReturnType<typeof createApp>;
  let runId: string;
  const logOf = (run: string, job = "api", headers: Record<string, string> = admin) =>
    logsApp.request(`/api/v1/projects/logs/runs/${run}/jobs/${job}/log?follow=true`, { headers });
  const setJob = (status: string) => db.sql`UPDATE jobs SET status = ${status} WHERE run_id = ${runId}`;

  before(async () => {
    logsApp = createApp({ version: "test" }, { sql: db.sql, resolveTarget, buildLogs });
    const put = await logsApp.request("/api/v1/projects/logs", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({
        githubRepo: "acme/logs",
        components: [{ name: "api", pipeline: "C", deployDir: "deploy/logs/api" }],
      }),
    });
    assert.equal(put.status, 200);
    const pulled = await logsApp.request("/api/v1/projects/logs/runs", { method: "POST", headers: admin, body: "{}" });
    runId = ((await pulled.json()) as { runId: string }).runId;
  });

  it("reads one run with its jobs' times; a run of another project or a malformed id is unknown", async () => {
    const res = await logsApp.request(`/api/v1/projects/logs/runs/${runId}`, { headers: admin });
    assert.equal(res.status, 200);
    const run = (await res.json()) as { id: string; requestedBy: string; jobs: Array<Record<string, unknown>> };
    assert.equal(run.id, runId);
    assert.equal(run.requestedBy, "admin");
    assert.deepEqual(run.jobs, [
      { name: "api", status: "queued", attempt: 0, startedAt: null, finishedAt: null, detail: {} },
    ]);
    assert.equal((await logsApp.request(`/api/v1/projects/demo/runs/${runId}`, { headers: admin })).status, 404);
    assert.equal((await logsApp.request("/api/v1/projects/logs/runs/not-a-uuid", { headers: admin })).status, 404);
  });

  it("needs read access like the run list: a viewer reads, an outsider learns nothing", async () => {
    await logsApp.request("/api/v1/projects/logs/members/viewer", {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ role: "viewer" }),
    });
    const viewer = { authorization: `Bearer ${await sessionFor("viewer")}` };
    const outsider = { authorization: `Bearer ${await sessionFor("outsider")}` };
    assert.equal((await logsApp.request(`/api/v1/projects/logs/runs/${runId}`, { headers: viewer })).status, 200);
    assert.equal((await logsApp.request(`/api/v1/projects/logs/runs/${runId}`, { headers: outsider })).status, 404);
    pods.set("api", { state: "open", pod: "p", body: lines("x\n") });
    assert.equal((await logOf(runId, "api", viewer)).status, 200);
    assert.equal((await logOf(runId, "api", outsider)).status, 404);
  });

  it("streams the build pod's log as plain text", async () => {
    pods.set("api", { state: "open", pod: "p", body: lines("#1 clone\n", "#2 build <b>ok</b>\n") });
    const res = await logOf(runId);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await res.text(), "#1 clone\n#2 build <b>ok</b>\n");
  });

  it("before the build prints it is 409; once the job is over and the pod gone, 410", async () => {
    pods.set("api", { state: "waiting" });
    assert.equal((await logOf(runId)).status, 409);
    pods.set("api", { state: "none" });
    await setJob("queued");
    assert.equal((await logOf(runId)).status, 409);
    await setJob("failed");
    const gone = await logOf(runId);
    assert.equal(gone.status, 410);
    assert.match(((await gone.json()) as { error: string }).error, /no longer available/);
  });

  it("an unknown job is 404; a cluster that cannot be reached is 502 without its error", async () => {
    assert.equal((await logOf(runId, "nope")).status, 404);
    pods.set("api", "throw");
    const res = await logOf(runId);
    assert.equal(res.status, 502);
    assert.doesNotMatch(await res.text(), /ECONNREFUSED/);
  });

  it("a client that stops reading ends the cluster request", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    pods.set("api", {
      state: "open",
      pod: "p",
      body: (async function* () {
        yield new TextEncoder().encode("first\n");
        await held;
      })(),
    });
    signals.length = 0;
    const res = await logOf(runId);
    const reader = res.body?.getReader();
    assert.ok(reader);
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n");
    await reader.cancel();
    assert.equal(signals[0]?.aborted, true);
    release();
  });

  it("without a cluster, logs are not enabled", async () => {
    const res = await app.request(`/api/v1/projects/logs/runs/${runId}/jobs/api/log`, { headers: admin });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /not enabled/);
  });
});

describe("audit log", () => {
  // A value that must never reach the audit log: a password, a token.
  const CANARY = "canary-Zq81-never-logged";
  const json = (body: unknown, headers: Record<string, string> = {}, method = "POST") => ({
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
  const eventsOf = async (query = "", headers: Record<string, string> = admin) =>
    (await (await app.request(`/api/v1/audit${query}`, { headers })).json()) as {
      events: Array<{
        action: string;
        actor: { kind: string; name: string | null; tokenId: string | null };
        projectId: string | null;
        target: string | null;
        detail: Record<string, unknown>;
        forwardedFor: string | null;
        userAgent: string | null;
      }>;
      next: string | null;
    };

  it("records sign-ins, failures and sign-outs; a failure names only a user who exists", async () => {
    await app.request(
      "/api/v1/auth/login",
      json(
        { username: "admin", password: PASSWORD },
        { "user-agent": "test-browser", "x-forwarded-for": "198.51.100.7" },
      ),
    );
    await app.request("/api/v1/auth/login", json({ username: "admin", password: CANARY }));
    await app.request("/api/v1/auth/login", json({ username: CANARY, password: PASSWORD }));
    const { events } = await eventsOf("?action=auth.login");
    const [unknownUser, wrongPassword, ok] = events;
    assert.deepEqual([ok?.action, ok?.actor.name, ok?.detail.via], ["auth.login", "admin", "password"]);
    assert.deepEqual([ok?.userAgent, ok?.forwardedFor], ["test-browser", "198.51.100.7"]);
    assert.deepEqual(
      [wrongPassword?.action, wrongPassword?.actor.name, wrongPassword?.detail.reason],
      ["auth.login.failed", "admin", "invalid"],
    );
    // A name that is not a user may be a password typed in the wrong field.
    assert.equal(unknownUser?.actor.name, null);
    assert.equal(unknownUser?.actor.kind, "anonymous");
  });

  it("records users, tokens, projects, members and runs, with who did it", async () => {
    await app.request("/api/v1/users", json({ username: "audited", password: `${CANARY}-pw` }, admin));
    await app.request("/api/v1/users/audited", json({ disabled: true }, admin, "PATCH"));
    const made = (await (await app.request("/api/v1/tokens", json({ name: "audit-ci" }, admin))).json()) as {
      id: string;
      token: string;
    };
    const tokenAuth = { authorization: `Bearer ${made.token}`, "content-type": "application/json" };
    const project = { githubRepo: "acme/audited", components: [{ name: "api", pipeline: "C", deployDir: "d/api" }] };
    await app.request("/api/v1/projects/audited", json(project, tokenAuth, "PUT"));
    await app.request("/api/v1/projects/audited", json(project, admin, "PUT"));
    await app.request("/api/v1/projects/audited/members/viewer", json({ role: "viewer" }, admin, "PUT"));
    await app.request("/api/v1/projects/audited/runs", json({}, admin));
    await app.request(`/api/v1/tokens/${made.id}`, { method: "DELETE", headers: admin });

    const actions = (await eventsOf("?limit=8")).events.map((e) => e.action).reverse();
    assert.deepEqual(actions, [
      "user.create",
      "user.update",
      "token.create",
      "project.create",
      "project.update",
      "project.member.set",
      "run.start",
      "token.revoke",
    ]);
    const created = (await eventsOf("?action=project.create")).events[0];
    // Done with the API token: the event names the token as well as its user.
    assert.deepEqual([created?.actor.kind, created?.actor.name, created?.actor.tokenId], ["token", "admin", made.id]);
    assert.deepEqual(created?.detail, { githubRepo: "acme/audited", components: ["api"], pipelineDef: false });
    const update = (await eventsOf("?action=user.update")).events[0];
    assert.deepEqual(update?.detail, { fields: ["disabled"], disabled: true });

    // No password or token value anywhere in the log.
    const [dump] = await db.sql<{ all: string }[]>`
      SELECT coalesce(string_agg(t::text, ' '), '') AS all FROM audit_events t`;
    assert.ok(!dump?.all.includes(CANARY), "a canary value reached the audit log");
    assert.ok(!dump?.all.includes(made.token));
  });

  it("filters and pages; bad parameters are refused with the reason", async () => {
    const page = await eventsOf("?limit=2");
    assert.equal(page.events.length, 2);
    assert.ok(page.next);
    const nextPage = await eventsOf(`?limit=2&before=${page.next}`);
    assert.equal(nextPage.events.length, 2);
    assert.equal((await eventsOf("?project=audited&action=run")).events[0]?.action, "run.start");
    for (const bad of ["?limit=0", "?limit=x", "?before=abc", "?since=yesterday", "?action=A%20B", "?nope=1"]) {
      assert.equal((await app.request(`/api/v1/audit${bad}`, { headers: admin })).status, 400, bad);
    }
  });

  it("administrators read everything; a project's maintainers read its events; viewers and outsiders do not", async () => {
    await createUser(db.sql, { username: "keeper", password: PASSWORD });
    await app.request("/api/v1/projects/audited/members/keeper", json({ role: "maintainer" }, admin, "PUT"));
    const keeper = { authorization: `Bearer ${await sessionFor("keeper")}` };
    const viewer = { authorization: `Bearer ${await sessionFor("viewer")}` };
    const outsider = { authorization: `Bearer ${await sessionFor("outsider")}` };

    const mine = await app.request("/api/v1/projects/audited/audit", { headers: keeper });
    assert.equal(mine.status, 200);
    const { events } = (await mine.json()) as { events: Array<{ projectId: string }> };
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.projectId === "audited"));
    assert.equal((await app.request("/api/v1/projects/audited/audit?project=other", { headers: keeper })).status, 400);

    assert.equal((await app.request("/api/v1/projects/audited/audit", { headers: viewer })).status, 403);
    assert.equal((await app.request("/api/v1/projects/audited/audit", { headers: outsider })).status, 404);
    assert.equal((await app.request("/api/v1/audit", { headers: keeper })).status, 403);
  });
});

describe("env and secrets", () => {
  // Made at run time: a literal here looks like a leaked key to the secret scan.
  const SECRET = `canary-${randomBytes(6).toString("hex")}`;
  const logged: string[] = [];
  const capture = (message: string, fields?: Record<string, unknown>) => {
    logged.push(`${message} ${JSON.stringify(fields ?? {})}`);
  };
  const repo = new MemoryRepo({
    "deploy/apps/envshop/api/deployment.yaml":
      "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api, namespace: envshop }\nspec:\n  template:\n    spec:\n      containers:\n        - name: api\n          envFrom: [{ secretRef: { name: api-env-secret } }]\n",
    "deploy/apps/envshop/api/kustomization.yaml": "resources:\n- deployment.yaml\n",
  });
  let envApp: ReturnType<typeof createApp>;
  let keeper: Record<string, string>;
  let viewer: Record<string, string>;
  let outsider: Record<string, string>;

  before(async () => {
    envApp = createApp(
      { version: "test" },
      {
        sql: db.sql,
        resolveTarget,
        env: { repo, codec: fakeCodec(), revisionKey: "k", cas: { sleep: async () => {} } },
        log: { debug: capture, info: capture, warn: capture, error: capture },
      },
    );
    await putProject(db.sql, {
      id: "envshop",
      name: "envshop",
      githubRepo: "acme/envshop",
      pipelineDef: null,
      metadata: {},
      components: [{ name: "api", pipeline: "C", deployDir: "deploy/apps/envshop/api" }],
    });
    for (const [username, role] of [
      ["env-keeper", "maintainer"],
      ["env-viewer", "viewer"],
    ] as const) {
      await createUser(db.sql, { username, password: PASSWORD });
      await envApp.request(`/api/v1/projects/envshop/members/${username}`, {
        method: "PUT",
        headers: admin,
        body: JSON.stringify({ role }),
      });
    }
    keeper = { authorization: `Bearer ${await sessionFor("env-keeper")}`, "content-type": "application/json" };
    viewer = { authorization: `Bearer ${await sessionFor("env-viewer")}`, "content-type": "application/json" };
    outsider = { authorization: `Bearer ${await sessionFor("outsider")}`, "content-type": "application/json" };
  });

  const read = async (headers: Record<string, string>) => envApp.request("/api/v1/projects/envshop/env", { headers });
  const layer = async (name: string) => {
    const body = (await (await read(keeper)).json()) as { layers: Array<{ layer: string; revision: string }> };
    return body.layers.find((l) => l.layer === name)?.revision as string;
  };
  const patch = (name: string, body: unknown, headers: Record<string, string>) =>
    envApp.request(`/api/v1/projects/envshop/env/${name}`, { method: "PATCH", headers, body: JSON.stringify(body) });

  it("maintainers set a secret; the response, the audit log, the logs and the commit carry its name, never its value", async () => {
    const res = await patch(
      "api",
      { expectedRevision: await layer("api"), set: { PORT: "8080" }, setSecrets: { DB_PASSWORD: SECRET } },
      keeper,
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text) as { status: string; commit: string; components: Array<{ consumers: string[] }> };
    assert.equal(body.status, "committed");
    assert.deepEqual(body.components[0]?.consumers, ["Deployment/api"]);

    const [event] = await db.sql<{ actor_name: string; target: string; detail: Record<string, unknown> }[]>`
      SELECT actor_name, target, detail FROM audit_events WHERE action = 'env.change' ORDER BY id DESC LIMIT 1`;
    assert.deepEqual(
      [event?.actor_name, event?.target, event?.detail],
      [
        "env-keeper",
        "api",
        { set: ["PORT"], unset: [], secretsSet: ["DB_PASSWORD"], secretsUnset: [], commit: body.commit },
      ],
    );

    const everything = [
      text,
      await (await read(keeper)).text(),
      await (await read(viewer)).text(),
      logged.join("\n"),
      repo.log.join("\n"),
      JSON.stringify((await db.sql`SELECT * FROM audit_events`).map((r) => r)),
      ...Object.entries(repo.files()).map(([p, t]) => `${p}\n${t}`),
    ].join("\n");
    assert.ok(!everything.includes(SECRET), "the secret value leaked");
  });

  it("viewers read plain values and secret names but cannot change them; outsiders learn nothing", async () => {
    const res = await read(viewer);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      canEdit: boolean;
      layers: Array<{ layer: string; plain: object; secrets: string[] }>;
    };
    assert.equal(body.canEdit, false);
    const api = body.layers.find((l) => l.layer === "api");
    assert.deepEqual([api?.plain, api?.secrets], [{ PORT: "8080" }, ["DB_PASSWORD"]]);
    assert.equal(((await (await read(keeper)).json()) as { canEdit: boolean }).canEdit, true);

    assert.equal((await patch("api", { expectedRevision: await layer("api"), set: { A: "1" } }, viewer)).status, 403);
    assert.equal((await read(outsider)).status, 404);
    assert.equal((await patch("api", { expectedRevision: await layer("api"), set: { A: "1" } }, outsider)).status, 404);
  });

  it("a stale revision is 409; bad input and unknown layers are 400 with the reason", async () => {
    const stale = await layer("api");
    assert.equal((await patch("api", { expectedRevision: stale, set: { A: "1" } }, keeper)).status, 200);
    const conflict = await patch("api", { expectedRevision: stale, set: { A: "2" } }, keeper);
    assert.equal(conflict.status, 409);
    assert.match(((await conflict.json()) as { error: string }).error, /changed since you read it/);

    const bad = await patch("api", { expectedRevision: await layer("api"), set: { "not-a-name": "1" } }, keeper);
    assert.equal(bad.status, 400);
    assert.equal((await patch("nope", { expectedRevision: await layer("api"), set: { A: "1" } }, keeper)).status, 400);
  });

  it("without an editor configured, the env endpoints say editing is off", async () => {
    const res = await app.request("/api/v1/projects/envshop/env", { headers: admin });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /not enabled/);
  });
});

function lines(...chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const c of chunks) yield new TextEncoder().encode(c);
  })();
}
