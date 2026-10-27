import assert from "node:assert/strict";
import { it } from "node:test";
import { plugin } from "./index.ts";

it("accepts a URL, a branch and a token reference", () => {
  assert.deepEqual(
    plugin.validateConfig({ url: "https://github.com/acme/deploy.git", branch: "main", token: { env: "T" } }),
    [],
  );
  assert.deepEqual(plugin.validateConfig({ url: "/srv/deploy.git", branch: "main" }), []);
});

it("rejects credentials in the URL, a plain token and a missing branch", () => {
  const problems = plugin.validateConfig({ url: "https://user:pw@github.com/a/b.git", token: "plain" });
  assert.ok(problems.includes("url must not contain credentials; use token"));
  assert.ok(problems.includes("token must be a reference: { env: NAME } or { file: PATH }"));
  assert.ok(problems.includes("branch must be a non-empty string"));
});
