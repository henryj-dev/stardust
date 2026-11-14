/**
 * The `builder` port over BuildKit Jobs: the image repository is
 * `<registry>/<project>/<component>`, and the build log is read from the build pod.
 */
import type { Builder, KubeStreamClient } from "@stardust/core";
import { runBuild } from "./executor.ts";
import { type BuilderOptions, buildJob } from "./job.ts";
import { buildLogReader } from "./logs.ts";

export interface BuildKitBuilderOptions extends BuilderOptions {
  kube: KubeStreamClient;
  /** Namespace the build Jobs run in. */
  namespace: string;
  /** Registry host and optional path. */
  registry: string;
}

export function createBuilder(options: BuildKitBuilderOptions): Builder {
  const { kube, namespace, registry, ...builderOptions } = options;
  return {
    async build(request, { signal, pollMs }) {
      const manifest = buildJob(
        { ...request, imageRepository: `${registry}/${request.projectId}/${request.component}` },
        builderOptions,
      );
      return runBuild(kube, namespace, manifest, { signal, ...(pollMs !== undefined ? { pollMs } : {}) });
    },
    logs: buildLogReader(kube, namespace),
  };
}
