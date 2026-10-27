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
 *     repository: acme/deploy
 *     branch: main
 *     buildRevAnnotation: example.com/build-rev   # optional
 */
export const plugin = definePlugin({
  manifest: { name: "gitops-git", description: "Writes desired state to a Git deploy repository." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s)) {
      if (!["repository", "branch", "buildRevAnnotation"].includes(key)) problems.push(`unknown key "${key}"`);
    }
    if (typeof s.repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s.repository)) {
      problems.push("repository must be owner/name");
    }
    if (s.branch !== undefined && (typeof s.branch !== "string" || s.branch === "")) {
      problems.push("branch must be a non-empty string");
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
