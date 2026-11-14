/**
 * What every compute provider must do, checked the same way for each:
 * create from the catalog, find what it made, change it within the port's
 * few verbs, and refuse to delete without an approval.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComputeProvider } from "../compute.ts";

export function computeProviderContract(name: string, make: () => Promise<ComputeProvider>) {
  describe(`compute contract: ${name}`, () => {
    it("lists a catalog to choose from", async () => {
      const c = await (await make()).catalog();
      assert.ok(c.regions.length > 0 && c.plans.length > 0 && c.images.length > 0);
      for (const p of c.plans) assert.ok(p.monthlyCost >= 0 && p.vcpus > 0, p.id);
    });

    it("creates an instance from the catalog, then finds it by id and in the list", async () => {
      const p = await make();
      const c = await p.catalog();
      const made = await p.create({
        label: "contract test",
        hostname: "contract-1.example.test",
        region: c.regions[0]?.id ?? "",
        plan: c.plans[0]?.id ?? "",
        image: c.images[0]?.id ?? "",
        userData: "#cloud-config\n",
        tags: ["stardust:test"],
      });
      assert.equal(made.hostname, "contract-1.example.test");
      assert.deepEqual((await p.get(made.id))?.id, made.id);
      assert.ok((await p.list()).some((i) => i.id === made.id));
      assert.equal(await p.get("00000000-0000-4000-8000-000000000000"), null);
      await p.clearUserData(made.id, "test");
      if (p.capabilities.resize && p.resize) {
        await p.resize(made.id, c.plans.at(-1)?.id ?? "");
        assert.equal((await p.get(made.id))?.plan, c.plans.at(-1)?.id);
      }
    });

    it("refuses to delete without an approval, and deletes with one", async () => {
      const p = await make();
      const c = await p.catalog();
      const made = await p.create({
        label: "to delete",
        hostname: "contract-2.example.test",
        region: c.regions[0]?.id ?? "",
        plan: c.plans[0]?.id ?? "",
        image: c.images[0]?.id ?? "",
      });
      await assert.rejects(p.destroy(made.id, ""));
      assert.ok(await p.get(made.id), "still there");
      await p.destroy(made.id, "approved");
      assert.equal(await p.get(made.id), null);
    });
  });
}
