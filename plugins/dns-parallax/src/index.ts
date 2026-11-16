/**
 * DNS on parallax (split horizon: internal and external views).
 *
 *   dns-parallax:
 *     apiUrl: https://parallax.example.com
 *     token: { env: PARALLAX_TOKEN }
 *     views: [internal, external]        # optional: the views stardust writes to
 */
import { definePlugin } from "@stardust/core";
import { parallaxDns } from "./parallax.ts";

export type { ParallaxOptions } from "./parallax.ts";
export { ParallaxError, parallaxDns } from "./parallax.ts";

const isRef = (v: unknown) =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && ("env" in v || "file" in v);

export const plugin = definePlugin({
  manifest: { name: "dns-parallax", description: "Split-horizon DNS records on parallax." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s))
      if (!["apiUrl", "token", "views"].includes(key)) problems.push(`unknown key "${key}"`);
    if (typeof s.apiUrl !== "string" || !/^https?:\/\/\S+$/.test(s.apiUrl))
      problems.push("apiUrl must be an http(s) URL");
    if (!isRef(s.token)) problems.push("token must be a reference: { env: NAME } or { file: PATH }");
    if (
      s.views !== undefined &&
      (!Array.isArray(s.views) || s.views.length === 0 || !s.views.every((v) => v === "internal" || v === "external"))
    ) {
      problems.push("views must list internal and/or external");
    }
    return problems;
  },
  provides: {
    ports: ["dns"],
    async create({ config, resolveSecret }) {
      return {
        dns: {
          parallax: parallaxDns({
            apiUrl: config.apiUrl as string,
            token: await resolveSecret(config.token, "plugins.dns-parallax.token"),
            ...(config.views ? { views: config.views as string[] } : {}),
          }),
        },
      };
    },
  },
});
