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
