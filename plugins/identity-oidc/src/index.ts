import { definePlugin, type Oidc } from "@stardust/core";
import { createOidc } from "./oidc.ts";

export type { OidcOptions } from "./oidc.ts";
export { createOidc } from "./oidc.ts";

const KEYS = [
  "issuer",
  "clientId",
  "clientSecret",
  "scopes",
  "groupsClaim",
  "allowedGroups",
  "adminGroups",
  "autoCreate",
  "displayName",
];
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");

/**
 * `plugins.identity-oidc` in stardust.yaml:
 *
 *   identity-oidc:
 *     displayName: Company SSO        # the sign-in button
 *     issuer: https://id.example.com
 *     clientId: stardust
 *     clientSecret: { env: OIDC_CLIENT_SECRET }
 *     allowedGroups: [developers]     # optional; without it anyone the provider accepts
 *     adminGroups: [platform]         # optional
 *     autoCreate: true                # create an account at first sign-in (default false)
 *
 * The redirect URI to register at the provider is <server.publicUrl>/login/oidc/callback.
 */
export const plugin = definePlugin({
  manifest: { name: "identity-oidc", description: "Signs people in through an OpenID Connect provider." },
  provides: {
    ports: ["identity"],
    async create({ config, resolveSecret, log, publicUrl }) {
      const at = "plugins.identity-oidc";
      const redirectUri = `${publicUrl}/login/oidc/callback`;
      const options = {
        issuer: config.issuer as string,
        clientId: config.clientId as string,
        clientSecret: await resolveSecret(config.clientSecret, `${at}.clientSecret`),
        redirectUri,
        ...(config.scopes ? { scopes: config.scopes as string[] } : {}),
        ...(config.groupsClaim ? { groupsClaim: config.groupsClaim as string } : {}),
      };
      // Discovery runs at first use and is retried after a failure.
      let pending: Promise<Oidc> | null = null;
      const client = () => {
        pending ??= createOidc(options).catch((err: Error) => {
          pending = null;
          log.error("OpenID discovery failed", { issuer: options.issuer, error: err.message });
          throw err;
        });
        return pending;
      };
      log.info("OpenID sign-in enabled", { issuer: options.issuer, redirectUri });
      return {
        identity: {
          client,
          redirectUri,
          displayName: (config.displayName as string | undefined) ?? "single sign-on",
          autoCreate: config.autoCreate === true,
          rules: {
            ...(config.allowedGroups ? { allowedGroups: config.allowedGroups as string[] } : {}),
            ...(config.adminGroups ? { adminGroups: config.adminGroups as string[] } : {}),
          },
        },
      };
    },
  },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s)) if (!KEYS.includes(key)) problems.push(`unknown key "${key}"`);
    if (typeof s.issuer !== "string" || !/^https:\/\/[^/]/.test(s.issuer)) problems.push("issuer must be an https URL");
    if (typeof s.clientId !== "string" || s.clientId === "") problems.push("clientId is required");
    if (s.clientSecret === undefined) problems.push("clientSecret is required (a secret reference)");
    for (const key of ["scopes", "allowedGroups", "adminGroups"]) {
      if (s[key] !== undefined && !strings(s[key])) problems.push(`${key} must be a list of names`);
    }
    if (s.groupsClaim !== undefined && typeof s.groupsClaim !== "string")
      problems.push("groupsClaim must be a claim name");
    if (s.autoCreate !== undefined && typeof s.autoCreate !== "boolean")
      problems.push("autoCreate must be true or false");
    if (s.displayName !== undefined && typeof s.displayName !== "string") problems.push("displayName must be text");
    return problems;
  },
});
