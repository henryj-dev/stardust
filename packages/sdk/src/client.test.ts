import assert from "node:assert/strict";
import { it } from "node:test";
import { createClient } from "./client.ts";

it("calls /healthz under the base url", async () => {
  const seen: string[] = [];
  const client = createClient({
    baseUrl: "http://api.test/",
    fetch: async (input) => {
      seen.push(String(input));
      return Response.json({ status: "ok", version: "1" });
    },
  });
  assert.deepEqual(await client.health(), { status: "ok", version: "1" });
  assert.deepEqual(seen, ["http://api.test/healthz"]);
});

it("throws on a non-2xx response", async () => {
  const client = createClient({ baseUrl: "http://api.test", fetch: async () => new Response("", { status: 503 }) });
  await assert.rejects(client.health(), /503/);
});

it("sends the token and reads runs; a 401 token check is false, not an error", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/api/v1/session")) return new Response("", { status: 401 });
      return Response.json({ runs: [{ id: "r1" }] });
    },
  });
  assert.deepEqual(await client.runs("demo"), [{ id: "r1" }]);
  assert.equal(await client.checkToken(), false);
  assert.deepEqual(seen[0], { url: "http://api.test/api/v1/projects/demo/runs", auth: "Bearer t0k" });
});

it("logs in; a wrong password and a lockout are results with the server's message", async () => {
  const answers: Record<string, Response> = {
    good: Response.json({ token: "s3ss", user: { id: "u", username: "a", displayName: "", isAdmin: true } }),
    wrong: Response.json({ error: "invalid username or password" }, { status: 401 }),
    locked: Response.json({ error: "too many failed attempts; try again later" }, { status: 429 }),
    broken: new Response("", { status: 500 }),
  };
  const client = createClient({
    baseUrl: "http://api.test",
    fetch: async (_input, init) => {
      const { password } = JSON.parse(String(init?.body)) as { password: string };
      return answers[password] as Response;
    },
  });
  const ok = await client.login("a", "good");
  assert.ok(ok.ok);
  assert.equal(ok.token, "s3ss");
  assert.deepEqual(await client.login("a", "wrong"), {
    ok: false,
    reason: "invalid",
    message: "invalid username or password",
  });
  assert.deepEqual(await client.login("a", "locked"), {
    ok: false,
    reason: "locked",
    message: "too many failed attempts; try again later",
  });
  await assert.rejects(client.login("a", "broken"), /500/);
});

it("pulls with a target and carries the server's reason when it is refused", async () => {
  const seen: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      seen.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
      if (seen.length === 1)
        return Response.json({ runId: "r1", ref: "refs/tags/v1", sha: "a".repeat(40) }, { status: 201 });
      return Response.json({ error: "tag nope was not found" }, { status: 422 });
    },
  });
  assert.deepEqual(await client.pull("demo", { tag: "v1" }), { runId: "r1", ref: "refs/tags/v1", sha: "a".repeat(40) });
  assert.deepEqual(seen[0], { url: "http://api.test/api/v1/projects/demo/runs", method: "POST", body: { tag: "v1" } });
  await assert.rejects(client.pull("demo", { tag: "nope" }), { status: 422, message: "tag nope was not found" });
  assert.deepEqual(seen[1]?.body, { tag: "nope" });
});

it("reads who the session belongs to; a rejected token is null, other failures throw", async () => {
  const user = { id: "u1", username: "ada", displayName: "Ada", isAdmin: false };
  let status = 200;
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async () => (status === 200 ? Response.json({ user }) : new Response("", { status })),
  });
  assert.deepEqual(await client.session(), user);
  assert.equal(await client.checkToken(), true);
  status = 401;
  assert.equal(await client.session(), null);
  status = 503;
  await assert.rejects(client.session(), /503/);
});

it("puts a whole project and carries the server's reason when it is refused", async () => {
  const seen: Array<{ url: string; method: string | undefined; auth: string | null; body: unknown }> = [];
  const project = {
    name: "demo",
    githubRepo: "acme/demo",
    pipelineDef: { jobs: [] },
    components: [{ name: "web", pipeline: "N" as const, port: 3000, deployDir: "apps/demo" }],
    metadata: { team: "a" },
  };
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method,
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      if (seen.length === 1) return Response.json({ id: "demo", ...project });
      return Response.json({ error: "invalid project: components[0].pipeline must be W, C or N" }, { status: 400 });
    },
  });
  assert.deepEqual(await client.putProject("demo", project), { id: "demo", ...project });
  assert.deepEqual(seen[0], {
    url: "http://api.test/api/v1/projects/demo",
    method: "PUT",
    auth: "Bearer t0k",
    body: project,
  });
  await assert.rejects(client.putProject("demo", project), {
    status: 400,
    message: "invalid project: components[0].pipeline must be W, C or N",
  });
});

it("reads one run, and relays a build log's response whatever its status", async () => {
  const seen: Array<{ url: string; auth: string | null; signal: boolean }> = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization"), signal: init?.signal != null });
      if (url.endsWith("/log?follow=true")) return new Response("line 1\n", { status: 200 });
      if (url.endsWith("/log")) return Response.json({ error: "gone" }, { status: 410 });
      if (url.endsWith("/runs/r%2F1")) return Response.json({ error: "unknown run" }, { status: 404 });
      return Response.json({ id: "r1", jobs: [] });
    },
  });
  assert.deepEqual(await client.run("demo", "r1"), { id: "r1", jobs: [] });
  await assert.rejects(client.run("demo", "r/1"), { status: 404 });
  const live = await client.buildLog("demo", "r1", "web", { follow: true, signal: new AbortController().signal });
  assert.equal(await live.text(), "line 1\n");
  assert.equal((await client.buildLog("demo", "r1", "web")).status, 410);
  assert.deepEqual(seen[0], { url: "http://api.test/api/v1/projects/demo/runs/r1", auth: "Bearer t0k", signal: false });
  assert.deepEqual(seen[2], {
    url: "http://api.test/api/v1/projects/demo/runs/r1/jobs/web/log?follow=true",
    auth: "Bearer t0k",
    signal: true,
  });
});

it("reads the enabled plugins and their capabilities", async () => {
  const plugins = [{ name: "runtime", capabilities: ["runtime.restart"] }];
  let asked = "";
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input) => {
      asked = String(input);
      return Response.json({ plugins });
    },
  });
  assert.deepEqual(await client.capabilities(), { plugins });
  assert.equal(asked, "http://api.test/api/v1/capabilities");
});

it("cancels a job, lists deliveries and rolls back, passing on the server's reason", async () => {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      const url = String(input);
      seen.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/cancel")) return Response.json({ error: "the job has already finished" }, { status: 409 });
      if (url.endsWith("/deliveries")) return Response.json({ deliveries: [{ jobId: "j1", sha: "a" }] });
      return Response.json({ status: "committed", job: "j1" });
    },
  });
  await assert.rejects(client.cancelJob("demo", "r 1", "api"), {
    status: 409,
    message: "the job has already finished",
  });
  assert.equal(seen[0]?.url, "http://api.test/api/v1/projects/demo/runs/r%201/jobs/api/cancel");
  assert.deepEqual(await client.deliveries("demo", "api"), [{ jobId: "j1", sha: "a" }]);
  assert.deepEqual(await client.rollback("demo", "api", "j1"), { status: "committed", job: "j1" });
  assert.deepEqual(seen[2], {
    url: "http://api.test/api/v1/projects/demo/components/api/rollback",
    method: "POST",
    body: { job: "j1" },
  });
  await client.rollback("demo", "api");
  assert.deepEqual(seen[3]?.body, {});
});

it("calls a plugin's API under its name and passes on its errors", async () => {
  const seen: Array<{ url: string; method: string; body: string | null }> = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      seen.push({ url: String(input), method: init?.method ?? "GET", body: (init?.body as string) ?? null });
      if (init?.method === "PUT") return Response.json({ error: "replicas must be a number" }, { status: 400 });
      return Response.json({ ok: true });
    },
  });
  const runtime = client.plugin("runtime");
  assert.deepEqual(await runtime.get("/projects/demo/components/api"), { ok: true });
  assert.equal(seen[0]?.url, "http://api.test/api/v1/plugins/runtime/projects/demo/components/api");
  await assert.rejects(runtime.send("PUT", "/x", { replicas: "2" }), {
    status: 400,
    message: "replicas must be a number",
  });
  assert.equal(seen[1]?.body, '{"replicas":"2"}');
});

it("lists, creates and revokes one's API tokens, passing on the server's reason", async () => {
  // Built at run time: no token-shaped literal in the source.
  const secret = ["sdt", "x".repeat(8)].join("_");
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "GET")
        return Response.json({
          tokens: [{ id: "a1", name: "ci", createdAt: "2026-01-01T00:00:00Z", expiresAt: null, lastUsedAt: null }],
        });
      if (method === "POST") {
        const { name } = JSON.parse(String(init?.body)) as { name: string };
        if (name === "taken") return Response.json({ error: 'a token named "taken" exists' }, { status: 409 });
        return Response.json({ id: "b2", token: secret }, { status: 201 });
      }
      if (url.endsWith("/gone")) return Response.json({ error: "unknown token" }, { status: 404 });
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await client.listTokens(), [
    { id: "a1", name: "ci", createdAt: "2026-01-01T00:00:00Z", expiresAt: null, lastUsedAt: null },
  ]);
  assert.deepEqual(seen[0], { url: "http://api.test/api/v1/tokens", method: "GET", body: null });
  assert.deepEqual(await client.createToken("deploy", 30), { id: "b2", token: secret });
  assert.deepEqual(seen[1], {
    url: "http://api.test/api/v1/tokens",
    method: "POST",
    body: { name: "deploy", expiresInDays: 30 },
  });
  await client.createToken("forever", null);
  assert.deepEqual(seen[2]?.body, { name: "forever", expiresInDays: null });
  await assert.rejects(client.createToken("taken", 7), { status: 409, message: 'a token named "taken" exists' });
  await client.revokeToken("a 1");
  assert.deepEqual(seen[4], { url: "http://api.test/api/v1/tokens/a%201", method: "DELETE", body: null });
  await assert.rejects(client.revokeToken("gone"), { status: 404, message: "unknown token" });
});

it("a refused token list is an error with the server's reason", async () => {
  const client = createClient({
    baseUrl: "http://api.test",
    fetch: async () => Response.json({ error: "not signed in" }, { status: 401 }),
  });
  await assert.rejects(client.listTokens(), { status: 401, message: "not signed in" });
});

it("asks whether a repository is readable, passing on the server's reason", async () => {
  const asked: string[] = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input) => {
      asked.push(String(input));
      return String(input).includes("bad")
        ? Response.json({ error: "repo must be owner/name" }, { status: 400 })
        : Response.json({ repo: "acme/web", readable: "app", installation: "selected" });
    },
  });
  assert.deepEqual(await client.sourceAccess("acme/web"), {
    repo: "acme/web",
    readable: "app",
    installation: "selected",
  });
  assert.equal(asked[0], "http://api.test/api/v1/source/access?repo=acme%2Fweb");
  await assert.rejects(client.sourceAccess("bad"), (err: Error) => err.message === "repo must be owner/name");
});

it("reads and sets a component's files, passing on the server's reason", async () => {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url: String(input), method: init?.method ?? "GET", body });
      if (init?.method !== "PUT") return Response.json({ mounts: [], secrets: ["APNS_KEY"] });
      if (body.mounts[0]?.key === "NOPE")
        return Response.json({ error: "NOPE is not a secret push reads" }, { status: 400 });
      return Response.json({ status: "committed", deployCommit: "abc", mounts: body.mounts });
    },
  });
  assert.deepEqual(await client.componentFiles("pico", "push"), { mounts: [], secrets: ["APNS_KEY"] });
  const mounts = [{ key: "APNS_KEY", path: "/etc/pico/AuthKey.p8" }];
  assert.deepEqual(await client.setComponentFiles("pico", "push", mounts), {
    status: "committed",
    deployCommit: "abc",
    mounts,
  });
  assert.deepEqual(seen[1], {
    url: "http://api.test/api/v1/projects/pico/components/push/files",
    method: "PUT",
    body: { mounts },
  });
  await assert.rejects(
    client.setComponentFiles("pico", "push", [{ key: "NOPE", path: "/x" }]),
    (err: Error) => err.message === "NOPE is not a secret push reads",
  );
});

it("reads and sets a component's storage, passing on the server's reason", async () => {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const empty = { namespace: "pico", volumes: [], kept: [], other: [], fsGroup: null };
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url: String(input), method: init?.method ?? "GET", body });
      if (init?.method !== "PUT") return Response.json(empty);
      if (body.volumes[0]?.size === "1G")
        return Response.json({ error: "volumes.0.size is not a size" }, { status: 400 });
      return Response.json({ status: "committed", deployCommit: "abc" });
    },
  });
  assert.deepEqual(await client.componentStorage("pico", "push"), empty);
  const change = { volumes: [{ name: "data", mountPath: "/var/lib/push", size: "1Gi" }], fsGroup: 10001 };
  assert.deepEqual(await client.setComponentStorage("pico", "push", change), {
    status: "committed",
    deployCommit: "abc",
  });
  assert.deepEqual(seen[1], {
    url: "http://api.test/api/v1/projects/pico/components/push/storage",
    method: "PUT",
    body: change,
  });
  await assert.rejects(
    client.setComponentStorage("pico", "push", { volumes: [{ name: "d", mountPath: "/x", size: "1G" }] }),
    (err: Error) => err.message === "volumes.0.size is not a size",
  );
});

it("reads and sets a component's access, and reseals pull Secrets", async () => {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const client = createClient({
    baseUrl: "http://api.test",
    token: "t0k",
    fetch: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url: String(input), method: init?.method ?? "GET", body });
      if (String(input).endsWith("/reseal"))
        return Response.json({ status: "committed", deployCommit: "def", components: ["pico/push"] });
      if (init?.method !== "PUT")
        return Response.json({
          namespace: "pico",
          registryPull: { available: true, on: false, others: [] },
          podView: { available: true, on: false },
        });
      if (body.podView === "x") return Response.json({ error: "podView must be true or false" }, { status: 400 });
      return Response.json({ status: "committed", deployCommit: "abc" });
    },
  });
  assert.equal((await client.componentAccess("pico", "push")).namespace, "pico");
  assert.deepEqual(await client.setComponentAccess("pico", "push", { registryPull: true }), {
    status: "committed",
    deployCommit: "abc",
  });
  assert.deepEqual(seen[1], {
    url: "http://api.test/api/v1/projects/pico/components/push/access",
    method: "PUT",
    body: { registryPull: true },
  });
  assert.deepEqual((await client.resealRegistryPull()).components, ["pico/push"]);
  assert.equal(seen[2]?.method, "POST");
  await assert.rejects(
    client.setComponentAccess("pico", "push", { podView: "x" as unknown as boolean }),
    (err: Error) => err.message === "podView must be true or false",
  );
});
