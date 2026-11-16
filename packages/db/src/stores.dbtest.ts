import { after, before } from "node:test";
import { guardStoreContract, sagaStoreContract } from "@stardust/core/testing";
import { guardStore, sagaStore } from "./stores.ts";
import { createTestDb, type TestDb } from "./testing.ts";

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => db.close());

sagaStoreContract("PostgreSQL", async () => sagaStore(db.sql));
guardStoreContract("PostgreSQL", async () => guardStore(db.sql));
