import { definePlugin } from "@stardust/core";

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
      if (!["url", "branch", "token", "username", "buildRevAnnotation"].includes(key))
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
export { stampPodTemplate } from "./stamp.ts";
