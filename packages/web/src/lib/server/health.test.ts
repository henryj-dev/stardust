import assert from "node:assert/strict";
import { it } from "node:test";
import { HEALTH_PATH, healthResponse, isHealthCheck } from "./health.ts";

it("answers 200 ok without a body on HEAD", async () => {
  const get = healthResponse("GET");
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "ok");
  assert.equal(get.headers.get("cache-control"), "no-store");
  const head = healthResponse("HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

it("exempts only the health path from session handling", () => {
  assert.equal(HEALTH_PATH, "/healthz");
  assert.equal(isHealthCheck("/healthz"), true);
  for (const other of ["/", "/healthz/", "/healthz/x", "/login", "/projects/healthz"])
    assert.equal(isHealthCheck(other), false, other);
});
