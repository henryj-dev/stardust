import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { after, it } from "node:test";
import { JOB_STATUSES } from "@stardust/core";
import { connect } from "./client.ts";
import { MIGRATIONS_DIR, migrate } from "./migrate.ts";
import { connectToSchema, createTestDb, testDatabaseUrl } from "./testing.ts";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

it("applies every migration once; a second run applies nothing", async () => {
  const db = await createTestDb();
  cleanups.push(db.close);
  assert.deepEqual(await migrate(db.sql), []);
  const names = await db.sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
  assert.ok(names.length >= 1);
  assert.equal(names[0]?.name, "0001_baseline.sql");
});

it("two concurrent migrators apply each file exactly once", async () => {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = connect(testDatabaseUrl(), { max: 1 });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const a = connectToSchema(schema);
  const b = connectToSchema(schema);
  cleanups.push(async () => {
    await a.end();
    await b.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length >= 2);
  assert.deepEqual([...ra, ...rb].sort(), files, "each file applied once in total");
  assert.ok(ra.length === 0 || rb.length === 0, "one migrator applied everything, the other waited and found nothing");
});

it("the jobs.status constraint lists exactly the core job states", async () => {
  const db = await createTestDb();
  cleanups.push(db.close);
  // This schema's constraints are picked first and only then described: other test
  // files drop their schemas meanwhile, and describing one of theirs fails.
  const [row] = await db.sql<{ def: string }[]>`
    WITH mine AS MATERIALIZED (
      SELECT c.oid FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${db.schema} AND t.relname = 'jobs' AND c.contype = 'c')
    SELECT def FROM (SELECT pg_get_constraintdef(oid) AS def FROM mine) d WHERE def LIKE '%status%'`;
  assert.ok(row, "no status constraint on jobs");
  const inDb = [...row.def.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inDb, [...JOB_STATUSES].sort());
});
