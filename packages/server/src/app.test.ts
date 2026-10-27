import assert from "node:assert/strict";
import { it } from "node:test";
import { createApp } from "./app.ts";

it("GET /healthz reports ok and the version", async () => {
  const res = await createApp({ version: "0.0.0-test" }).request("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", version: "0.0.0-test" });
});

it("unknown paths are 404", async () => {
  const res = await createApp({ version: "0.0.0-test" }).request("/nope");
  assert.equal(res.status, 404);
});
