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

it("accepts a GitHub App for a GitHub repository, and refuses it with a token, another host or a plain key", () => {
  const app = { appId: 123, privateKey: { file: "/run/secrets/app.pem" } };
  assert.deepEqual(
    plugin.validateConfig({ url: "https://github.com/acme/deploy.git", branch: "main", githubApp: app }),
    [],
  );
  const problems = (s: Record<string, unknown>) =>
    plugin.validateConfig({ url: "https://github.com/acme/deploy.git", branch: "main", ...s });
  assert.ok(problems({ githubApp: app, token: { env: "T" } }).includes("use either token or githubApp, not both"));
  assert.ok(
    plugin
      .validateConfig({ url: "https://gitea.example.com/acme/deploy.git", branch: "main", githubApp: app })
      .includes("githubApp needs url to be https://github.com/<owner>/<name>"),
  );
  assert.deepEqual(problems({ githubApp: { appId: 0, privateKey: "-----BEGIN", extra: 1 } }).sort(), [
    "githubApp.appId must be a positive integer",
    "githubApp.privateKey must be a reference: { env: NAME } or { file: PATH }",
    'githubApp: unknown key "extra"',
  ]);
});
