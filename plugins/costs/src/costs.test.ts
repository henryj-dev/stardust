import assert from "node:assert/strict";
import { it } from "node:test";
import type { FeatureContext } from "@stardust/core";
import { monthlyCosts } from "./index.ts";

it("adds each source up, and shows one that cannot answer as unknown, not zero", async () => {
  const ctx = {
    ports: {
      costs: {
        vultr: {
          monthly: async () => ({
            currency: "USD",
            lines: [
              { name: "b", detail: "large", monthly: 40 },
              { name: "a", detail: "small", monthly: 5.004 },
            ],
          }),
        },
        broken: { monthly: () => Promise.reject(new Error("billing API down")) },
      },
    },
  } as unknown as FeatureContext;
  const { sources } = await monthlyCosts(ctx);
  assert.deepEqual(
    sources.map((s) => [s.name, s.total, s.error]),
    [
      ["broken", null, "billing API down"],
      ["vultr", 45, null],
    ],
  );
});
