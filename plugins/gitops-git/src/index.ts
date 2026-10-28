import { definePlugin } from "@stardust/core";
import { repoFromUrl } from "./github-app.ts";

export type { BumpImage, BumpResult } from "./bump.ts";
export { bumpImage, bumpMessage } from "./bump.ts";
export type { BoundRepo, CasOptions, CommitPlan } from "./cas.ts";
export { commitWithCas } from "./cas.ts";
export type { DirectoryPlan, DirectoryRewrite, FileRewrite, RewriteResult } from "./image-tag.ts";
export {
  imageRefTag,
  imageTagPattern,
  isBumpCandidate,
  orderBumpCandidates,
  planDirectoryRewrite,
  rewriteBuildRev,
  rewriteImageTag,
} from "./image-tag.ts";
export { addResource, listResources, removeResource } from "./kustomization.ts";
export type { CommitErrorKind, CommitResult, PendingCommit, RepoFile, RepoIO } from "./repo.ts";
export { isRetryable } from "./repo.ts";

/**
 * `plugins.gitops-git` in stardust.yaml:
 *
 *   gitops-git:
 *     url: https://github.com/acme/deploy.git
 *     branch: main
 *     token: { env: DEPLOY_TOKEN }               # optional for local paths
 *     username: x-access-token                    # optional
 *     buildRevAnnotation: example.com/build-rev   # optional
 *
 * Or, for a GitHub repository, as a GitHub App instead of a token:
 *
 *     githubApp:
 *       appId: 123456
 *       privateKey: { file: /run/secrets/deploy-app.pem }
 *       apiBaseUrl: https://api.github.com        # optional
 */
const isRef = (v: unknown) =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && ("env" in v || "file" in v);

export const plugin = definePlugin({
  manifest: { name: "gitops-git", description: "Writes desired state to a Git deploy repository." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s)) {
      if (!["url", "branch", "token", "username", "buildRevAnnotation", "githubApp"].includes(key))
        problems.push(`unknown key "${key}"`);
    }
    if (typeof s.url !== "string" || !/^(https?:\/\/|file:\/\/|\/)\S+$/.test(s.url)) {
      problems.push("url must be an http(s) URL, a file:// URL or an absolute path");
    } else if (/^https?:\/\/[^/]*@/.test(s.url)) {
      problems.push("url must not contain credentials; use token");
    }
    if (typeof s.branch !== "string" || s.branch === "") problems.push("branch must be a non-empty string");
    if (s.token !== undefined && !isRef(s.token))
      problems.push("token must be a reference: { env: NAME } or { file: PATH }");
    if (s.username !== undefined && typeof s.username !== "string") problems.push("username must be a string");
    if (s.githubApp !== undefined) {
      const app = s.githubApp as Record<string, unknown> | null;
      if (s.token !== undefined) problems.push("use either token or githubApp, not both");
      if (typeof s.url === "string" && !repoFromUrl(s.url))
        problems.push("githubApp needs url to be https://github.com/<owner>/<name>");
      if (typeof app !== "object" || app === null) {
        problems.push("githubApp must be a mapping with appId and privateKey");
      } else {
        for (const key of Object.keys(app)) {
          if (!["appId", "privateKey", "apiBaseUrl"].includes(key)) problems.push(`githubApp: unknown key "${key}"`);
        }
        if (!Number.isInteger(app.appId) || (app.appId as number) <= 0)
          problems.push("githubApp.appId must be a positive integer");
        if (!isRef(app.privateKey))
          problems.push("githubApp.privateKey must be a reference: { env: NAME } or { file: PATH }");
        if (
          app.apiBaseUrl !== undefined &&
          (typeof app.apiBaseUrl !== "string" || !/^https:\/\/\S+$/.test(app.apiBaseUrl))
        )
          problems.push("githubApp.apiBaseUrl must be an https URL");
      }
    }
    if (
      s.buildRevAnnotation !== undefined &&
      (typeof s.buildRevAnnotation !== "string" || !s.buildRevAnnotation.includes("/"))
    ) {
      problems.push("buildRevAnnotation must be a prefixed annotation key, e.g. example.com/build-rev");
    }
    return problems;
  },
});

export type { GitCliOptions } from "./git-cli.ts";
export { GitCliRepo } from "./git-cli.ts";
export type { GitHubAppOptions } from "./github-app.ts";
export { appJwt, installationTokens, repoFromUrl } from "./github-app.ts";
export { stampPodTemplate } from "./stamp.ts";
