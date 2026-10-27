import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, type LoadConfigOptions, parseConfig } from "./load.ts";

const VALID = `
version: 1
server:
  publicUrl: https://stardust.example.com
database:
  url: { env: DATABASE_URL }
plugins:
  source-github: {}
`;

const env = { DATABASE_URL: "postgres://user:pass@db:5432/stardust" };

async function issuesOf(text: string, options: LoadConfigOptions = { env }): Promise<string[]> {
  try {
    await parseConfig(text, "test.yaml", options);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
    return err.issues.map((i) => `${i.path}: ${i.message}`);
  }
  assert.fail("expected the configuration to be rejected");
}

describe("parseConfig", () => {
  it("accepts a minimal configuration and fills defaults", async () => {
    const config = await parseConfig(VALID, "test.yaml", { env });
    assert.equal(config.server.host, "0.0.0.0");
    assert.equal(config.server.port, 8080);
    assert.equal(config.database.url, env.DATABASE_URL);
    assert.deepEqual(config.plugins, { "source-github": {} });
  });

  it("reads a secret from a file reference", async () => {
    const text = VALID.replace("{ env: DATABASE_URL }", "{ file: /run/secrets/db }");
    const config = await parseConfig(text, "test.yaml", {
      env: {},
      readSecretFile: async (path) => (path === "/run/secrets/db" ? "postgres://from-file\n" : ""),
    });
    assert.equal(config.database.url, "postgres://from-file");
  });

  it("rejects unknown keys and names them", async () => {
    const issues = await issuesOf(VALID.replace("server:", "servr: {}\nserver:"));
    assert.ok(
      issues.some((i) => i.includes("servr")),
      issues.join("\n"),
    );
  });

  it("rejects a plain-text database url", async () => {
    const issues = await issuesOf(VALID.replace("{ env: DATABASE_URL }", "postgres://u:p@db/x"));
    assert.ok(
      issues.some((i) => i.startsWith("database.url:")),
      issues.join("\n"),
    );
  });

  it("names the missing environment variable", async () => {
    const issues = await issuesOf(VALID, { env: {} });
    assert.deepEqual(issues, ["database.url: environment variable DATABASE_URL is not set"]);
  });

  it("rejects an out-of-range port with its path", async () => {
    const issues = await issuesOf(VALID.replace("server:", "server:\n  port: 70000"));
    assert.ok(
      issues.some((i) => i.startsWith("server.port:")),
      issues.join("\n"),
    );
  });

  it("rejects a non-http public url", async () => {
    const issues = await issuesOf(VALID.replace("https://stardust.example.com", "ftp://x"));
    assert.ok(
      issues.some((i) => i.startsWith("server.publicUrl:")),
      issues.join("\n"),
    );
  });

  it("rejects an unsupported version", async () => {
    const issues = await issuesOf(VALID.replace("version: 1", "version: 2"));
    assert.ok(
      issues.some((i) => i.startsWith("version:")),
      issues.join("\n"),
    );
  });

  it("reports every schema problem at once", async () => {
    const issues = await issuesOf("version: 1\nserver: {}\n");
    assert.ok(
      issues.some((i) => i.startsWith("server.publicUrl:")),
      issues.join("\n"),
    );
    assert.ok(
      issues.some((i) => i.startsWith("database:")),
      issues.join("\n"),
    );
  });

  it("rejects text that is not YAML", async () => {
    const issues = await issuesOf("version: [1\n");
    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? "", /not valid YAML/);
  });
});
