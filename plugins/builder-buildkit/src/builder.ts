/**
 * The `builder` port over BuildKit Jobs: the image repository is
 * `<registry>/<project>/<component>`, and the build log is read from the build pod.
 */
import { randomBytes } from "node:crypto";
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
      const { cloneToken, ...rest } = request;
      // A one-time token: the Job is made suspended, its Secret owned by it, then it is let go.
      const oneTime =
        cloneToken && rest.trusted !== false && rest.kind !== "mirror"
          ? (() => {
              const jobName = `build-${rest.projectId}-${rest.component}-${randomBytes(4).toString("hex")}`.slice(
                0,
                63,
              );
              return { jobName, secret: `${jobName}-clone`.slice(0, 63) };
            })()
          : undefined;
      const manifest = buildJob(
        {
          ...rest,
          imageRepository: `${registry}/${rest.projectId}/${rest.component}`,
          ...(oneTime ? { oneTimeClone: oneTime } : {}),
        },
        builderOptions,
      );
      const ns = encodeURIComponent(namespace);
      return runBuild(kube, namespace, manifest, {
        signal,
        ...(pollMs !== undefined ? { pollMs } : {}),
        ...(oneTime && cloneToken
          ? {
              afterCreate: async (job: { name: string; uid: string }) => {
                const secret = await kube.request("POST", `/api/v1/namespaces/${ns}/secrets`, {
                  apiVersion: "v1",
                  kind: "Secret",
                  type: "Opaque",
                  metadata: {
                    name: oneTime.secret,
                    labels: { "app.kubernetes.io/managed-by": "stardust" },
                    // Deleted with the Job.
                    ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: job.name, uid: job.uid }],
                  },
                  stringData: { token: cloneToken },
                });
                if (secret.status < 200 || secret.status >= 300) {
                  throw new Error(`the clone token's Secret could not be made: ${secret.status}`);
                }
                const released = await kube.request(
                  "PATCH",
                  `/apis/batch/v1/namespaces/${ns}/jobs/${encodeURIComponent(job.name)}`,
                  {
                    spec: { suspend: false },
                  },
                );
                if (released.status < 200 || released.status >= 300)
                  throw new Error(`the build Job could not be released: ${released.status}`);
              },
            }
          : {}),
      });
    },
    logs: buildLogReader(kube, namespace),
  };
}
