/**
 * The grant Job's script, run for real against the test PostgreSQL with
 * psql: twice (it must change nothing the second time), with a password
 * that would break any quoting short of psql's own. Skipped where psql is
 * not installed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { it } from "node:test";
import { parse } from "yaml";
import { statefulSetPostgres } from "./statefulset.ts";

const url = new URL(process.env.DATABASE_URL_TEST ?? "postgres://postgres@127.0.0.1:5432/postgres");
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGPASSWORD: decodeURIComponent(url.password),
};
const hasPsql = spawnSync("psql", ["--version"]).status === 0;
const psql = (user: string, password: string, db: string, sql: string) =>
  spawnSync("psql", ["-Atq", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", db, "-c", sql], {
    env: { ...env, PGPASSWORD: password },
    encoding: "utf8",
  });

it("creates the role and database once, idempotently, quoting the password safely", {
  skip: !hasPsql && "psql is not installed",
}, () => {
  const suffix = randomBytes(4).toString("hex");
  const role = `grant_${suffix}`;
  const database = `grantdb_${suffix}`;
  const password = `it's "odd" $(id) \`x\` ;-- ${suffix}`;
  const p = statefulSetPostgres({
    kube: { request: async () => ({ status: 404, body: "" }) },
    namespace: "db",
    namespaces: [],
  });
  const files = p.renderAppGrant(
    { name: "x", ref: { namespace: "db", name: "x" }, host: env.PGHOST, superuser: { name: "s", key: "k" } },
    { database, role, password: { name: "app-pw", key: "password" } },
  );
  const job = parse(Object.values(files)[0] ?? "") as {
    spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
  };
  const script = job.spec.template.spec.containers[0]?.command[2] ?? "";
  try {
    for (const round of [1, 2]) {
      const run = spawnSync("sh", ["-c", script], { env: { ...env, APP_PASSWORD: password }, encoding: "utf8" });
      assert.equal(run.status, 0, `round ${round}: ${run.stderr}`);
      assert.match(run.stdout, new RegExp(`\\[ok\\] ${role} owns ${database}`));
    }
    const seen = psql(
      role,
      password,
      database,
      "SELECT current_user || ' ' || (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) || ' ' || has_database_privilege('public', current_database(), 'CONNECT')",
    );
    assert.equal(seen.status, 0, seen.stderr);
    assert.equal(
      seen.stdout.trim(),
      `${role} ${role} false`,
      "the role signs in with that password and owns its database; PUBLIC may not connect",
    );
  } finally {
    psql("postgres", env.PGPASSWORD, "postgres", `DROP DATABASE IF EXISTS ${database}`);
    psql("postgres", env.PGPASSWORD, "postgres", `DROP ROLE IF EXISTS ${role}`);
  }
});
