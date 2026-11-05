import assert from "node:assert/strict";
import { it } from "node:test";
import { plugin, RETIRED_KEYS } from "./index.ts";

const secret = { env: "S" };

it("accepts GitHub App credentials or a token", () => {
  assert.deepEqual(plugin.validateConfig({ appId: 42, privateKey: { file: "/k.pem" } }), []);
  assert.deepEqual(plugin.validateConfig({ apiBaseUrl: "http://gitea:3000/api/v1", token: { env: "T" } }), []);
});

it("rejects plain-text secrets, both kinds of credentials, and unknown keys", () => {
  const problems = plugin.validateConfig({ appId: "x", privateKey: "-----BEGIN", extra: 1 });
  assert.deepEqual(problems.sort(), [
    "appId must be a positive integer",
    "privateKey must be a reference: { env: NAME } or { file: PATH }",
    'unknown key "extra"',
  ]);
  assert.ok(plugin.validateConfig({ appId: 1, privateKey: secret, token: secret }).some((p) => p.includes("not both")));
  assert.deepEqual(plugin.validateConfig({ token: "ghp_plain" }), [
    "token must be a reference: { env: NAME } or { file: PATH }",
  ]);
});

it("needs no credentials for public repositories", () => {
  assert.deepEqual(plugin.validateConfig({}), []);
  assert.deepEqual(plugin.validateConfig({ apiBaseUrl: "https://api.github.com" }), []);
});

it("still accepts a webhook secret from an older configuration, so an upgrade needs no edit", () => {
  assert.ok("webhookSecret" in RETIRED_KEYS);
  assert.deepEqual(plugin.validateConfig({ token: secret, webhookSecret: secret }), []);
  // Whatever shape it has: it is never read.
  assert.deepEqual(plugin.validateConfig({ webhookSecret: "hunter2" }), []);
});
