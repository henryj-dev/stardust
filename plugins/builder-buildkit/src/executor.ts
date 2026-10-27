/**
 * Runs a build Job to completion and reports the pushed image's digest.
 *
 * A build that succeeded without printing a digest counts as failed: without
 * the digest the deploy repository cannot be pointed at what was built.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { DIGEST_LINE } from "./job.ts";
import type { KubeClient } from "./kube.ts";

export interface BuildOutcome {
  result: "success" | "failed" | "cancelled";
  jobName: string;
  digest?: string;
  /** Why it failed, when it did. */
  reason?: string;
  /** The last lines of the build container's log. */
  logTail: string;
}

export interface RunBuildOptions {
  signal: AbortSignal;
  pollMs?: number;
  /** Lines of log kept in the outcome. */
  tailLines?: number;
}

interface JobStatus {
  metadata?: { name?: string };
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

const ok = (status: number) => status >= 200 && status < 300;

async function api<T>(kube: KubeClient, method: string, path: string, body?: unknown): Promise<T> {
  const res = await kube.request(method, path, body);
  if (!ok(res.status))
    throw new Error(`kubernetes API ${method} ${path} returned ${res.status}: ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body) as T;
}

export async function runBuild(
  kube: KubeClient,
  namespace: string,
  manifest: Record<string, unknown>,
  options: RunBuildOptions,
): Promise<BuildOutcome> {
  const ns = encodeURIComponent(namespace);
  const created = await api<JobStatus>(kube, "POST", `/apis/batch/v1/namespaces/${ns}/jobs`, manifest);
  const jobName = created.metadata?.name;
  if (!jobName) throw new Error("created Job has no name");
  const jobPath = `/apis/batch/v1/namespaces/${ns}/jobs/${encodeURIComponent(jobName)}`;

  let result: BuildOutcome["result"] | null = null;
  let reason: string | undefined;
  while (result === null) {
    if (options.signal.aborted) {
      await kube.request("DELETE", `${jobPath}?propagationPolicy=Background`);
      return { result: "cancelled", jobName, reason: "cancelled", logTail: "" };
    }
    const job = await api<JobStatus>(kube, "GET", jobPath);
    const failedCondition = job.status?.conditions?.find((c) => c.type === "Failed" && c.status === "True");
    if ((job.status?.succeeded ?? 0) > 0) result = "success";
    else if ((job.status?.failed ?? 0) > 0 || failedCondition) {
      result = "failed";
      reason = failedCondition?.reason ?? "the build container failed";
    } else {
      await sleep(options.pollMs ?? 2_000, undefined, { signal: options.signal }).catch(() => {});
    }
  }

  const logTail = await buildLog(kube, ns, jobName, options.tailLines ?? 200);
  if (result === "success") {
    const digest = DIGEST_LINE.exec(logTail)?.[1];
    if (!digest)
      return { result: "failed", jobName, reason: "the build succeeded but printed no image digest", logTail };
    return { result, jobName, digest, logTail };
  }
  return { result, jobName, logTail, ...(reason ? { reason } : {}) };
}

async function buildLog(kube: KubeClient, ns: string, jobName: string, tailLines: number): Promise<string> {
  const pods = await api<{ items?: Array<{ metadata?: { name?: string } }> }>(
    kube,
    "GET",
    `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
  );
  const pod = pods.items?.[0]?.metadata?.name;
  if (!pod) return "";
  const res = await kube.request(
    "GET",
    `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod)}/log?container=build&tailLines=${tailLines}`,
  );
  return ok(res.status) ? res.body : "";
}
