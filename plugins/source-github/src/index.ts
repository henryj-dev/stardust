import { definePlugin } from "@stardust/core";

const isSecretRef = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  const v = value as Record<string, unknown>;
  return keys.length === 1 && (typeof v.env === "string" || typeof v.file === "string");
};

/**
 * Keys an older stardust.yaml may still carry. They are accepted and ignored,
 * so an upgrade needs no change to the configuration; the server says so once.
 */
export const RETIRED_KEYS: Readonly<Record<string, string>> = {
  webhookSecret: "webhooks were removed; runs start only when someone asks for one",
};

/**
 * `plugins.source-github` in stardust.yaml. Authenticate either as a GitHub App
 * or with a token (a GitHub token, or a Gitea token for its GitHub-compatible
 * API), never both — or not at all, for public repositories only. Runs start
 * only when someone asks for one (the API or the dashboard):
 *
 *   source-github:
 *     apiBaseUrl: https://api.github.com          # optional
 *     appId: 123456
 *     privateKey: { file: /run/secrets/github-app.pem }
 */
export const plugin = definePlugin({
  manifest: { name: "source-github", description: "Builds from GitHub repositories (or a GitHub-compatible API)." },
  validateConfig(section) {
    const problems: string[] = [];
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!["apiBaseUrl", "appId", "privateKey", "token"].includes(key) && !(key in RETIRED_KEYS))
        problems.push(`unknown key "${key}"`);
    }
    if (s.apiBaseUrl !== undefined && (typeof s.apiBaseUrl !== "string" || !/^https?:\/\/[^\s]+$/.test(s.apiBaseUrl))) {
      problems.push("apiBaseUrl must be an http(s) URL");
    }
    const app = s.appId !== undefined || s.privateKey !== undefined;
    if (app && s.token !== undefined) problems.push("use either appId and privateKey, or token — not both");
    if (app) {
      if (!Number.isInteger(s.appId) || (s.appId as number) <= 0) problems.push("appId must be a positive integer");
      if (!isSecretRef(s.privateKey)) problems.push("privateKey must be a reference: { env: NAME } or { file: PATH }");
    } else if (s.token !== undefined && !isSecretRef(s.token)) {
      problems.push("token must be a reference: { env: NAME } or { file: PATH }");
    }
    return problems;
  },
});
