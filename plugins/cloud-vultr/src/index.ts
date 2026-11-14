/**
 * The compute port on Vultr.
 *
 *   cloud-vultr:
 *     account: vultr                  # optional: its name in the compute port
 *     broker:                         # recommended: the key stays in the broker
 *       url: http://vultr-broker.stardust.svc:8080
 *       token: { env: VULTR_BROKER_TOKEN }
 *     deleteApprovalKey: { env: VULTR_DELETE_APPROVAL_KEY }  # with a broker: signs its delete tickets
 *     apiKey: { env: VULTR_API_KEY }  # without a broker; or as a fallback when it cannot be reached
 *
 * With both, calls go to the broker and fall back to the key only when the
 * broker cannot be reached at all; every fallback is logged as a warning.
 */
import { definePlugin, isKubeName } from "@stardust/core";
import { vultrClient } from "./client.ts";
import { computeCosts, vultrCompute } from "./vultr.ts";

export { type ApprovalClaims, approvalClaims, signApproval } from "./approval.ts";
export { decideFallback, type FallbackDecision, VultrHttpError, vultrClient } from "./client.ts";
export { computeCosts, mapInstance, type VultrComputeOptions, vultrCompute } from "./vultr.ts";

const isRef = (v: unknown) =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && ("env" in v || "file" in v);

export const plugin = definePlugin({
  manifest: { name: "cloud-vultr", description: "Cloud instances on Vultr, through a broker that holds the key." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems = Object.keys(s)
      .filter((k) => !["account", "broker", "apiKey", "apiBaseUrl", "deleteApprovalKey"].includes(k))
      .map((k) => `unknown key "${k}"`);
    if (s.account !== undefined && !isKubeName(s.account)) problems.push("account must be a lowercase name");
    if (s.broker === undefined && s.apiKey === undefined) problems.push("set broker (recommended) or apiKey");
    if (s.broker !== undefined) {
      const b = s.broker as { url?: unknown; token?: unknown };
      if (typeof b.url !== "string" || !/^https?:\/\/\S+$/.test(b.url))
        problems.push("broker.url must be an http(s) URL");
      if (!isRef(b.token)) problems.push("broker.token must be a reference: { env: NAME } or { file: PATH }");
    }
    if (s.broker !== undefined && !isRef(s.deleteApprovalKey)) {
      problems.push(
        "deleteApprovalKey must be a reference: the broker refuses deletes without a ticket signed with it",
      );
    }
    if (s.apiKey !== undefined && !isRef(s.apiKey))
      problems.push("apiKey must be a reference: { env: NAME } or { file: PATH }");
    if (s.apiBaseUrl !== undefined && (typeof s.apiBaseUrl !== "string" || !/^https:\/\/\S+$/.test(s.apiBaseUrl))) {
      problems.push("apiBaseUrl must be an https URL");
    }
    return problems;
  },
  provides: {
    ports: ["compute", "costs"],
    async create({ config, resolveSecret, log }) {
      const c = config as {
        account?: string;
        broker?: { url: string; token: never };
        apiKey?: never;
        apiBaseUrl?: string;
        deleteApprovalKey?: never;
      };
      const client = vultrClient({
        ...(c.broker
          ? {
              broker: {
                url: c.broker.url,
                token: await resolveSecret(c.broker.token, "plugins.cloud-vultr.broker.token"),
              },
            }
          : {}),
        ...(c.apiKey ? { apiKey: await resolveSecret(c.apiKey, "plugins.cloud-vultr.apiKey") } : {}),
        ...(c.apiBaseUrl ? { apiBaseUrl: c.apiBaseUrl } : {}),
        onFallback: (call, reason) =>
          log.warn("the Vultr broker could not be reached: called Vultr directly, past its allowlist", {
            call,
            reason,
          }),
      });
      const deleteApprovalKey = c.deleteApprovalKey
        ? await resolveSecret(c.deleteApprovalKey, "plugins.cloud-vultr.deleteApprovalKey")
        : undefined;
      const compute = vultrCompute(client, deleteApprovalKey ? { deleteApprovalKey } : {});
      const account = c.account ?? "vultr";
      return { compute: { [account]: compute }, costs: { [account]: computeCosts(compute) } };
    },
  },
});
