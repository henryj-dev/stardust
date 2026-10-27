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
