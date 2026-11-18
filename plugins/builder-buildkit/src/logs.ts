/**
 * Reads a build's log from its pod while Kubernetes still has it: live while
 * the build runs, in full until the finished Job is cleaned up. stardust keeps
 * no copy, so a cleaned-up build has no log.
 *
 * The container read is the build container when the pod has one, else the
 * pod's main container (a Worker release's is `deploy`, after `clone` and
 * `build` init containers). Until it starts, an init step that is running or
 * has failed is read instead, so a release that stops early still shows why.
 */

import type { BuildLogReader, KubeStreamClient } from "@stardust/core";
import { BUILD_CONTAINER, LABEL_PREFIX } from "./job.ts";

export interface BuildLogOptions {
  /** Lines from the end the log starts with. */
  tailLines?: number;
  /** Bytes after which Kubernetes ends the response, follow or not. */
  limitBytes?: number;
}

// Label values: what Kubernetes accepts, so a query cannot widen the selector.
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]{0,61})?[A-Za-z0-9])$/;

type Status = { name?: string; state?: { terminated?: { exitCode?: number } } & Record<string, unknown> };
interface Pod {
  metadata?: { name?: string; creationTimestamp?: string };
  spec?: { containers?: Array<{ name?: string }> };
  status?: { containerStatuses?: Status[]; initContainerStatuses?: Status[] };
}
interface PodList {
  items?: Pod[];
}

/** The container whose log to read, or null while nothing has started printing. */
function containerOf(pod: Pod): string | null {
  const main = (pod.spec?.containers ?? []).flatMap((c) => (c.name ? [c.name] : []));
  const target = main.length === 0 || main.includes(BUILD_CONTAINER) ? BUILD_CONTAINER : (main[0] as string);
  const state = pod.status?.containerStatuses?.find((c) => c.name === target)?.state;
  if (state && !("waiting" in state)) return target;
  for (const init of pod.status?.initContainerStatuses ?? []) {
    const s = init.state;
    if (!init.name || !s) continue;
    if ("running" in s || ("terminated" in s && (s.terminated?.exitCode ?? 0) !== 0)) return init.name;
  }
  return null;
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
    const container = containerOf(pod);
    if (!container) return { state: "waiting" };

    const query = new URLSearchParams({
      container,
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
