/**
 * DNS on Cloudflare.
 *
 *   dns-cloudflare:
 *     token: { env: CLOUDFLARE_DNS_TOKEN }   # Zone:Read and DNS:Edit
 *     zones: [example.com]                   # optional: only these
 */
import { definePlugin } from "@stardust/core";
import { cloudflareDns } from "./cloudflare.ts";

export type { CloudflareOptions } from "./cloudflare.ts";
export { cloudflareDns } from "./cloudflare.ts";

const isRef = (v: unknown) =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && ("env" in v || "file" in v);

export const plugin = definePlugin({
  manifest: { name: "dns-cloudflare", description: "DNS records on Cloudflare." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s))
      if (!["token", "zones", "apiBaseUrl"].includes(key)) problems.push(`unknown key "${key}"`);
    if (!isRef(s.token)) problems.push("token must be a reference: { env: NAME } or { file: PATH }");
    if (
      s.zones !== undefined &&
      (!Array.isArray(s.zones) || !s.zones.every((z) => typeof z === "string" && z !== ""))
    ) {
      problems.push("zones must be a list of zone names");
    }
    if (s.apiBaseUrl !== undefined && (typeof s.apiBaseUrl !== "string" || !/^https?:\/\/\S+$/.test(s.apiBaseUrl))) {
      problems.push("apiBaseUrl must be an http(s) URL");
    }
    return problems;
  },
  provides: {
    ports: ["dns"],
    async create({ config, resolveSecret }) {
      return {
        dns: {
          cloudflare: cloudflareDns({
            token: await resolveSecret(config.token, "plugins.dns-cloudflare.token"),
            ...(config.zones ? { zones: config.zones as string[] } : {}),
            ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl as string } : {}),
          }),
        },
      };
    },
  },
});
