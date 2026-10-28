import assert from "node:assert/strict";
import { it } from "node:test";
import { plugin } from "./index.ts";

const secret = { env: "S" };

it("accepts GitHub App credentials or a token", () => {
  assert.deepEqual(plugin.validateConfig({ appId: 42, privateKey: { file: "/k.pem" }, webhookSecret: secret }), []);
  assert.deepEqual(
    plugin.validateConfig({ apiBaseUrl: "http://gitea:3000/api/v1", token: { env: "T" }, webhookSecret: secret }),
    [],
  );
});

it("rejects plain-text secrets, both kinds of credentials, and unknown keys", () => {
  const problems = plugin.validateConfig({ appId: "x", privateKey: "-----BEGIN", webhookSecret: "hunter2", extra: 1 });
  assert.deepEqual(problems.sort(), [
    "appId must be a positive integer",
    "privateKey must be a reference: { env: NAME } or { file: PATH }",
    'unknown key "extra"',
    "webhookSecret must be a reference: { env: NAME } or { file: PATH }",
  ]);
  assert.ok(
    plugin
      .validateConfig({ appId: 1, privateKey: secret, token: secret, webhookSecret: secret })
      .some((p) => p.includes("not both")),
  );
  assert.deepEqual(plugin.validateConfig({ token: "ghp_plain" }), [
    "token must be a reference: { env: NAME } or { file: PATH }",
  ]);
});

it("needs no credentials or webhook secret for public repositories with manual runs only", () => {
  assert.deepEqual(plugin.validateConfig({}), []);
  assert.deepEqual(plugin.validateConfig({ apiBaseUrl: "https://api.github.com" }), []);
});
