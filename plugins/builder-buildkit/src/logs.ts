/**
 * Reads a build's log from its pod while Kubernetes still has it: live while
 * the build runs, in full until the finished Job is cleaned up. stardust keeps
 * no copy, so a cleaned-up build has no log.
 */
import { LABEL_PREFIX } from "./job.ts";
import type { KubeStreamClient } from "./kube.ts";

export interface BuildLogQuery {
  runId: string;
  /** The job's name in the run, as the build pod's label carries it. */
  jobName: string;
  /** Keep the response open and send lines as the build prints them. */
  follow: boolean;
  signal: AbortSignal;
}

export type BuildLog =
  /** No pod: the build has not been created yet, or it was cleaned up. */
  | { state: "none" }
  /** The pod exists but the build container has not started (cloning, pulling the image). */
  | { state: "waiting" }
  | { state: "open"; pod: string; body: AsyncIterable<Uint8Array> };

export interface BuildLogOptions {
  /** Lines from the end the log starts with. */
  tailLines?: number;
  /** Bytes after which Kubernetes ends the response, follow or not. */
  limitBytes?: number;
}

export type BuildLogReader = (query: BuildLogQuery) => Promise<BuildLog>;

// Label values: what Kubernetes accepts, so a query cannot widen the selector.
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]{0,61})?[A-Za-z0-9])$/;

interface PodList {
  items?: Array<{
    metadata?: { name?: string; creationTimestamp?: string };
    status?: { containerStatuses?: Array<{ name?: string; state?: Record<string, unknown> }> };
  }>;
}

export function buildLogReader(
  kube: KubeStreamClient,
  namespace: string,
  options: BuildLogOptions = {},
): BuildLogReader {
  const ns = encodeURIComponent(namespace);
  const tailLines = options.tailLines ?? 5_000;
  const limitBytes = options.limitBytes ?? 4 * 1024 * 1024;
  return async ({ runId, jobName, follow, signal }) => {
    if (!LABEL_VALUE.test(runId) || !LABEL_VALUE.test(jobName)) return { state: "none" };
    const selector = `${LABEL_PREFIX}/run=${runId},${LABEL_PREFIX}/job=${jobName}`;
    const res = await kube.request(
      "GET",
      `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(selector)}`,
    );
    if (res.status < 200 || res.status >= 300)
      throw new Error(`kubernetes API listing build pods returned ${res.status}`);
    // A retried job has a pod per attempt; the newest is the current one.
    const pods = ((JSON.parse(res.body) as PodList).items ?? []).sort((a, b) =>
      (b.metadata?.creationTimestamp ?? "").localeCompare(a.metadata?.creationTimestamp ?? ""),
    );
    const pod = pods[0];
    const name = pod?.metadata?.name;
    if (!name) return { state: "none" };
    const build = pod.status?.containerStatuses?.find((c) => c.name === "build");
    if (!build?.state || "waiting" in build.state) return { state: "waiting" };

    const query = new URLSearchParams({
      container: "build",
      follow: String(follow),
      tailLines: String(tailLines),
      limitBytes: String(limitBytes),
    });
    const log = await kube.stream(`/api/v1/namespaces/${ns}/pods/${encodeURIComponent(name)}/log?${query}`, signal);
    // 400: the container is not running yet (or any more, between attempts).
    if (log.status === 400) {
      await drain(log.body);
      return { state: "waiting" };
    }
    if (log.status === 404) {
      await drain(log.body);
      return { state: "none" };
    }
    if (log.status < 200 || log.status >= 300) {
      await drain(log.body);
      throw new Error(`kubernetes API reading the build log returned ${log.status}`);
    }
    return { state: "open", pod: name, body: log.body };
  };
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const _ of body);
  } catch {
    // The error body is not needed.
  }
}
