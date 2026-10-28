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

  it("reads an empty plugin section as an empty mapping, as Helm renders `{}`", async () => {
    const config = await parseConfig(VALID.replace("  source-github: {}", "  source-github:"), "test.yaml", { env });
    assert.deepEqual(config.plugins, { "source-github": {} });
    const helm = await parseConfig(VALID.replace("  source-github: {}", "  source-github: null"), "test.yaml", { env });
    assert.deepEqual(helm.plugins, { "source-github": {} });
  });

  it("resolves the bootstrap administrator's password reference", async () => {
    const text = VALID.replace(
      "  publicUrl:",
      "  bootstrapAdmin: { username: admin, password: { env: ADMIN_PW } }\n  publicUrl:",
    );
    const config = await parseConfig(text, "test.yaml", { env: { ...env, ADMIN_PW: "a long password" } });
    assert.deepEqual(config.server.bootstrapAdmin, { username: "admin", password: "a long password" });
    const missing = await issuesOf(text);
    assert.deepEqual(missing, ["server.bootstrapAdmin.password: environment variable ADMIN_PW is not set"]);
    const plain = await issuesOf(text.replace("{ env: ADMIN_PW }", "hunter2hunter2"));
    assert.ok(
      plain.some((i) => i.startsWith("server.bootstrapAdmin.password")),
      plain.join("\n"),
    );
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

describe("resolveSecretRef", () => {
  it("resolves env and file references and names the path on failure", async () => {
    const { resolveSecretRef } = await import("./load.ts");
    assert.equal(await resolveSecretRef({ env: "TOKEN" }, "plugins.x.token", { env: { TOKEN: "t" } }), "t");
    assert.equal(await resolveSecretRef({ file: "/s" }, "plugins.x.token", { readSecretFile: async () => "f\n" }), "f");
    await assert.rejects(resolveSecretRef({ env: "TOKEN" }, "plugins.x.token", { env: {} }), (err: ConfigError) =>
      err.issues.some((i) => i.path === "plugins.x.token" && /TOKEN is not set/.test(i.message)),
    );
    await assert.rejects(resolveSecretRef("plain", "plugins.x.token"), (err: ConfigError) =>
      err.issues.some((i) => i.path === "plugins.x.token"),
    );
  });
});
