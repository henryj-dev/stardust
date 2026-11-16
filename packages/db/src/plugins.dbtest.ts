import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { databasePort } from "./plugins.ts";
import { createTestDb, type TestDb } from "./testing.ts";

let db: TestDb;
before(async () => {
  db = await createTestDb();
  await db.sql`CREATE TABLE port_items (id int PRIMARY KEY, text text NOT NULL)`;
});
after(async () => db.close());

describe("the database port", () => {
  it("runs parameterised statements: a value never becomes SQL", async () => {
    const database = databasePort(db.sql);
    const evil = "x'); DROP TABLE port_items; --";
    await database.query("INSERT INTO port_items (id, text) VALUES ($1, $2)", [1, evil]);
    assert.deepEqual(await database.query("SELECT text FROM port_items WHERE id = $1", [1]), [{ text: evil }]);
  });

  it("commits a transaction that resolves and rolls back one that throws, savepoints included", async () => {
    const database = databasePort(db.sql);
    await database.transaction(async (tx) => {
      await tx.query("INSERT INTO port_items (id, text) VALUES (2, 'kept')");
      await assert.rejects(
        tx.transaction(async (inner) => {
          await inner.query("INSERT INTO port_items (id, text) VALUES (3, 'inner, rolled back')");
          throw new Error("inner fails");
        }),
      );
    });
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.query("INSERT INTO port_items (id, text) VALUES (4, 'rolled back')");
        throw new Error("outer fails");
      }),
    );
    const ids = (await database.query<{ id: number }>("SELECT id FROM port_items ORDER BY id")).map((r) => r.id);
    assert.deepEqual(ids, [1, 2]);
  });
});
