import assert from "node:assert/strict";
import { it } from "node:test";
import { plugin } from "./index.ts";

it("accepts a configuration with secret references", () => {
  assert.deepEqual(
    plugin.validateConfig({ appId: 42, privateKey: { file: "/run/key.pem" }, webhookSecret: { env: "GH_SECRET" } }),
    [],
  );
});

it("rejects plain-text secrets, a bad app id and unknown keys, all at once", () => {
  const problems = plugin.validateConfig({ appId: "x", privateKey: "-----BEGIN", webhookSecret: "hunter2", extra: 1 });
  assert.deepEqual(problems.sort(), [
    "appId must be a positive integer",
    "privateKey must be a reference: { env: NAME } or { file: PATH }",
    'unknown key "extra"',
    "webhookSecret must be a reference: { env: NAME } or { file: PATH }",
  ]);
});
