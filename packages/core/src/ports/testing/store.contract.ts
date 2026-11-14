/** The contract every ObjectStore keeps: the memory fake and each real store run it. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ObjectStore } from "../store.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

export function objectStoreContract(name: string, make: () => Promise<ObjectStore>): void {
  describe(`ObjectStore contract: ${name}`, () => {
    it("puts and gets bytes; a missing key is null", async () => {
      const store = await make();
      await store.put("contract/a/one.log", bytes("one\n"), "text/plain");
      assert.equal(text(await store.get("contract/a/one.log")), "one\n");
      assert.equal(await store.get("contract/a/missing.log"), null);
      await store.put("contract/a/one.log", bytes("replaced\n"), "text/plain");
      assert.equal(text(await store.get("contract/a/one.log")), "replaced\n");
    });

    it("lists keys under a prefix, in order, and nothing outside it", async () => {
      const store = await make();
      for (const key of ["contract/l/b.log", "contract/l/a.log", "contract/l/sub/c.log", "contract/other.log"]) {
        await store.put(key, bytes(key), "text/plain");
      }
      assert.deepEqual(await store.list("contract/l/"), [
        "contract/l/a.log",
        "contract/l/b.log",
        "contract/l/sub/c.log",
      ]);
    });

    it("deletes, and deleting what is not there is fine", async () => {
      const store = await make();
      await store.put("contract/d/x.log", bytes("x"), "text/plain");
      await store.delete("contract/d/x.log");
      assert.equal(await store.get("contract/d/x.log"), null);
      await store.delete("contract/d/x.log");
    });

    it("keeps binary content as it was", async () => {
      const store = await make();
      const data = new Uint8Array([0, 255, 10, 13, 128]);
      await store.put("contract/b/data.bin", data, "application/octet-stream");
      assert.deepEqual([...((await store.get("contract/b/data.bin")) ?? [])], [...data]);
    });
  });
}
