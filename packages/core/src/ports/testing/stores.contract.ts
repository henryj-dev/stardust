/**
 * Contracts for the platform stores: the in-memory fakes and the database
 * implementations run the same suites.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GuardStore } from "../../guard.ts";
import type { SagaRecord, SagaStore } from "../../saga.ts";

export function sagaStoreContract(name: string, make: () => Promise<SagaStore>): void {
  describe(`SagaStore contract: ${name}`, () => {
    const record = (id: string): SagaRecord => ({
      id,
      kind: "test.thing",
      status: "running",
      state: { step: 0, names: ["a"] },
      done: [],
      failedStep: null,
      error: null,
    });

    it("keeps a record and its JSON state between save and load; unknown is null", async () => {
      const store = await make();
      const id = "00000000-0000-4000-8000-000000000001";
      await store.create(record(id));
      const loaded = await store.load(id);
      assert.deepEqual(loaded, record(id));
      await store.save({ ...record(id), status: "compensated", done: ["a"], failedStep: "b", error: "boom" });
      assert.deepEqual(await store.load(id), {
        ...record(id),
        status: "compensated",
        done: ["a"],
        failedStep: "b",
        error: "boom",
      });
      assert.equal(await store.load("00000000-0000-4000-8000-000000000009"), null);
    });

    it("refuses to create the same saga twice", async () => {
      const store = await make();
      const id = "00000000-0000-4000-8000-000000000002";
      await store.create(record(id));
      await assert.rejects(store.create(record(id)));
    });
  });
}

export function guardStoreContract(name: string, make: () => Promise<GuardStore>): void {
  describe(`GuardStore contract: ${name}`, () => {
    it("uses an id once per scope", async () => {
      const store = await make();
      const later = new Date(Date.now() + 60_000);
      assert.equal(await store.useOnce("approval", "t1", later), true);
      assert.equal(await store.useOnce("approval", "t1", later), false);
      assert.equal(await store.useOnce("other", "t1", later), true, "scopes are separate");
    });

    it("counts events per key inside the window", async () => {
      const store = await make();
      assert.equal(await store.count("reveal", "u1", 60_000), 1);
      assert.equal(await store.count("reveal", "u1", 60_000), 2);
      assert.equal(await store.count("reveal", "u2", 60_000), 1, "keys are separate");
    });
  });
}
