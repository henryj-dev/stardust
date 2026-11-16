/**
 * Costs: what every source that bills (a compute account) says it costs a
 * month, added up for the home page. A source that cannot answer is shown as
 * such, never as zero.
 *
 *   costs: {}
 */
import { definePlugin, type FeatureContext, type Route } from "@stardust/core";

export async function monthlyCosts(ctx: FeatureContext) {
  const sources = await Promise.all(
    Object.entries(ctx.ports.costs ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([name, source]) => {
        try {
          const report = await source.monthly();
          const total = report.lines.reduce((sum, l) => sum + l.monthly, 0);
          return {
            name,
            currency: report.currency,
            total: Math.round(total * 100) / 100,
            lines: report.lines,
            error: null,
          };
        } catch (err) {
          return { name, currency: null, total: null, lines: [], error: (err as Error).message.slice(0, 300) };
        }
      }),
  );
  return { sources };
}

function routes(ctx: FeatureContext): Route[] {
  return [
    {
      method: "GET",
      path: "/monthly",
      permission: "costs:read",
      handle: async () => ({ status: 200, body: await monthlyCosts(ctx) }),
    },
  ];
}

export const plugin = definePlugin({
  manifest: { name: "costs", description: "What the billed sources cost a month." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    return Object.keys(section).map((k) => `unknown key "${k}"`);
  },
  requires: ["costs"],
  permissions: [{ id: "costs:read", description: "See monthly costs", grantedTo: "admins" }],
  capabilities: ["costs.monthly"],
  routes,
});
