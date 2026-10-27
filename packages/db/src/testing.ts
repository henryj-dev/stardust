/**
 * Test databases: every test gets its own schema in the database named by
 * DATABASE_URL_TEST, migrated from scratch, and dropped afterwards.
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { connect } from "./client.ts";
import { migrate } from "./migrate.ts";

export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error("DATABASE_URL_TEST is not set; database tests need a PostgreSQL to run against");
  }
  return url;
}

/** Connects with search_path set to `schema`. */
export function connectToSchema(schema: string, max = 4): Sql {
  return connect(testDatabaseUrl(), { max, connection: { search_path: schema } });
}

export interface TestDb {
  sql: Sql;
  schema: string;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = connect(testDatabaseUrl(), { max: 1 });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const sql = connectToSchema(schema);
  await migrate(sql);
  return {
    sql,
    schema,
    async close() {
      await sql.end();
      const cleanup = connect(testDatabaseUrl(), { max: 1 });
      await cleanup.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}
