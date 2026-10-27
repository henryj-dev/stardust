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
 * `plugins.source-github` in stardust.yaml:
 *
 *   source-github:
 *     appId: 123456
 *     privateKey: { file: /run/secrets/github-app.pem }
 *     webhookSecret: { env: GITHUB_WEBHOOK_SECRET }
 */
export const plugin = definePlugin({
  manifest: { name: "source-github", description: "Builds from GitHub repositories through a GitHub App." },
  validateConfig(section) {
    const problems: string[] = [];
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!["appId", "privateKey", "webhookSecret"].includes(key)) problems.push(`unknown key "${key}"`);
    }
    if (!Number.isInteger(s.appId) || (s.appId as number) <= 0) problems.push("appId must be a positive integer");
    for (const key of ["privateKey", "webhookSecret"]) {
      if (!isSecretRef(s[key])) problems.push(`${key} must be a reference: { env: NAME } or { file: PATH }`);
    }
    return problems;
  },
});
