import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { TABLE_SCOPES } from "./scopes.ts";
import { createTestDb, type TestDb } from "./testing.ts";

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => db.close());

it("every table stardust creates says where it lives, and the list names no table that is gone", async () => {
  const rows = await db.sql<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = ${db.schema} AND table_type = 'BASE TABLE' ORDER BY 1`;
  assert.deepEqual(
    rows.map((r) => r.name),
    Object.keys(TABLE_SCOPES).sort(),
  );
});
