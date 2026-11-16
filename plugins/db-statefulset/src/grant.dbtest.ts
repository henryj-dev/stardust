/**
 * The grant Job's script, run for real against the test PostgreSQL with
 * psql: twice (it must change nothing the second time), with a password
 * that would break any quoting short of psql's own, as `postgres` and as a
 * superuser of another name (an image's POSTGRES_USER). Skipped where psql
 * is not installed.
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

for (const as of ["postgres", "another superuser"] as const)
  it(
    `creates the role and database once, idempotently, quoting the password safely, as ${as}`,
    {
      skip: !hasPsql && "psql is not installed",
    },
    () => grantAs(as),
  );

function grantAs(as: "postgres" | "another superuser") {
  const suffix = randomBytes(4).toString("hex");
  const su = as === "postgres" ? undefined : { role: `grant_su_${suffix}`, password: randomBytes(12).toString("hex") };
  if (su) {
    const made = psql(
      "postgres",
      env.PGPASSWORD,
      "postgres",
      `CREATE ROLE ${su.role} SUPERUSER LOGIN PASSWORD '${su.password}'`,
    );
    assert.equal(made.status, 0, made.stderr);
  }
  const role = `grant_${suffix}`;
  const database = `grantdb_${suffix}`;
  const password = `it's "odd" $(id) \`x\` ;-- ${suffix}`;
  const p = statefulSetPostgres({
    kube: { request: async () => ({ status: 404, body: "" }) },
    namespace: "db",
    namespaces: [],
  });
  const files = p.renderAppGrant(
    {
      name: "x",
      ref: { namespace: "db", name: "x" },
      host: env.PGHOST,
      superuser: { name: "s", key: "k", ...(su ? { role: su.role } : {}) },
    },
    { database, role, password: { name: "app-pw", key: "password" } },
  );
  const job = parse(Object.values(files)[0] ?? "") as {
    spec: {
      template: { spec: { containers: Array<{ command: string[]; env: Array<{ name: string; value?: string }> }> } };
    };
  };
  const container = job.spec.template.spec.containers[0];
  const script = container?.command[2] ?? "";
  // The plain env as rendered (PGUSER among it); the Secret-backed values from here.
  const plain = Object.fromEntries(
    (container?.env ?? []).flatMap((e) => (e.value === undefined || e.name === "PGHOST" ? [] : [[e.name, e.value]])),
  );
  assert.equal(plain.PGUSER, su?.role ?? "postgres");
  try {
    for (const round of [1, 2]) {
      const run = spawnSync("sh", ["-c", script], {
        env: { ...env, ...plain, PGPASSWORD: su?.password ?? env.PGPASSWORD, APP_PASSWORD: password },
        encoding: "utf8",
      });
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
    if (su) psql("postgres", env.PGPASSWORD, "postgres", `DROP ROLE IF EXISTS ${su.role}`);
  }
}
