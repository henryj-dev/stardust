/** The contract every DnsProvider keeps: run against each adapter over a faked provider API. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DnsProvider } from "../dns.ts";

export function dnsProviderContract(name: string, zone: string, setup: () => Promise<DnsProvider>): void {
  describe(`DnsProvider contract: ${name}`, () => {
    /** The first view, for a provider with views; nothing otherwise. */
    const view = async (p: DnsProvider): Promise<{ view?: string }> => {
      const first = p.capabilities.views[0];
      return first === undefined ? {} : { view: first };
    };

    it("lists its zones, fully qualified", async () => {
      const p = await setup();
      assert.ok((await p.listZones()).includes(zone));
    });

    it("creates a record, finds it by name and type, and replaces it in place", async () => {
      const p = await setup();
      const v = await view(p);
      const made = await p.upsert(zone, { name: `API.${zone}.`, type: "A", content: "192.0.2.10", ttl: 300, ...v });
      assert.equal(made.name, `api.${zone}`, "names come back normalised");
      assert.equal(made.content, "192.0.2.10");
      const again = await p.upsert(zone, { name: `api.${zone}`, type: "A", content: "192.0.2.11", ttl: 60, ...v });
      assert.equal(again.id, made.id, "the same record, replaced");
      const found = await p.listRecords(zone, { name: `api.${zone}`, type: "A", ...v });
      assert.deepEqual(
        found.map((r) => [r.name, r.content, r.ttl]),
        [[`api.${zone}`, "192.0.2.11", 60]],
      );
      if (p.capabilities.views.length > 0) assert.equal(found[0]?.view, v.view);
    });

    it("keeps a record of another type at the same name apart", async () => {
      const p = await setup();
      const v = await view(p);
      await p.upsert(zone, { name: `www.${zone}`, type: "A", content: "192.0.2.20", ttl: 300, ...v });
      await p.upsert(zone, { name: `www.${zone}`, type: "TXT", content: "hello", ttl: 300, ...v });
      const both = await p.listRecords(zone, { name: `www.${zone}`, ...v });
      assert.deepEqual(both.map((r) => r.type).sort(), ["A", "TXT"]);
    });

    it("deletes, and deleting what is gone is fine", async () => {
      const p = await setup();
      const v = await view(p);
      const r = await p.upsert(zone, { name: `old.${zone}`, type: "CNAME", content: `api.${zone}`, ttl: 300, ...v });
      await p.delete(zone, r.id, v.view);
      assert.deepEqual(await p.listRecords(zone, { name: `old.${zone}`, ...v }), []);
      await p.delete(zone, r.id, v.view);
    });

    it("refuses a record outside the zone before asking the provider", async () => {
      const p = await setup();
      await assert.rejects(
        p.upsert(zone, { name: "api.other.test", type: "A", content: "192.0.2.1", ttl: 300, ...(await view(p)) }),
        /not in the zone/,
      );
    });
  });
}
