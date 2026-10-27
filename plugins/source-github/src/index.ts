import { definePlugin } from "@stardust/core";

export type { Decision, ProjectView } from "./decide.ts";
export { decideWebhook, refToBranchTag } from "./decide.ts";
export type { ForkVerdict } from "./fork.ts";
export { judgeForkPullRequest } from "./fork.ts";
export type { ChangedPaths, CompareResult } from "./paths.ts";
export { COMPARE_FILES_LIMIT, resolveChangedPaths, unionOfCommits } from "./paths.ts";
export type { WebhookKind, WebhookPolicy } from "./policy.ts";
export { isProjectDisabled, judgePush, POLICY, SELF_COMMIT_RE, SKIP_CI_RE } from "./policy.ts";
export { verifySignature } from "./signature.ts";

const isSecretRef = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  const v = value as Record<string, unknown>;
  return keys.length === 1 && (typeof v.env === "string" || typeof v.file === "string");
};

/**
 * `plugins.source-github` in stardust.yaml. Authenticate either as a GitHub App
 * or with a token (a GitHub token, or a Gitea token for its GitHub-compatible
 * webhooks), never both:
 *
 *   source-github:
 *     apiBaseUrl: https://api.github.com          # optional
 *     appId: 123456
 *     privateKey: { file: /run/secrets/github-app.pem }
 *     webhookSecret: { env: GITHUB_WEBHOOK_SECRET }
 */
export const plugin = definePlugin({
  manifest: { name: "source-github", description: "Builds from GitHub repositories (or GitHub-compatible webhooks)." },
  validateConfig(section) {
    const problems: string[] = [];
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!["apiBaseUrl", "appId", "privateKey", "token", "webhookSecret"].includes(key))
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
    } else if (!isSecretRef(s.token)) {
      problems.push("authenticate with appId and privateKey, or with token: { env: NAME } or { file: PATH }");
    }
    if (!isSecretRef(s.webhookSecret))
      problems.push("webhookSecret must be a reference: { env: NAME } or { file: PATH }");
    return problems;
  },
});
