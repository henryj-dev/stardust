import { definePlugin } from "@stardust/core";

export type { BuilderOptions, BuildInput } from "./job.ts";
export { BUILD_SCRIPT, BuildInputError, buildJob, CLONE_SCRIPT, DEFAULT_IMAGES, DIGEST_LINE } from "./job.ts";

const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `plugins.builder-buildkit` in stardust.yaml:
 *
 *   builder-buildkit:
 *     namespace: stardust-builds
 *     registry: registry.example.com/team
 *     cloneSecret: github-clone
 *     pushSecret: registry-push
 */
export const plugin = definePlugin({
  manifest: {
    name: "builder-buildkit",
    description: "Builds container images in Kubernetes Jobs with rootless BuildKit.",
  },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s)) {
      if (!["namespace", "registry", "cloneSecret", "pushSecret"].includes(key)) problems.push(`unknown key "${key}"`);
    }
    for (const key of ["namespace", "cloneSecret", "pushSecret"]) {
      if (typeof s[key] !== "string" || !DNS_NAME.test(s[key] as string)) problems.push(`${key} must be a DNS label`);
    }
    if (typeof s.registry !== "string" || !/^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)*$/.test(s.registry)) {
      problems.push("registry must be a registry host with an optional path, without a tag");
    }
    return problems;
  },
});
export type { BuildOutcome, RunBuildOptions } from "./executor.ts";
export { runBuild } from "./executor.ts";
export type { KubeClient, KubeResponse } from "./kube.ts";
export { inClusterClient } from "./kube.ts";
