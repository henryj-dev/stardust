/**
 * Runs a Kubernetes Job to its end through the kube port: create it, poll
 * until it succeeds or fails (deleting it when the signal aborts), and keep
 * the last lines of its pod's log. What success means beyond the Job's own
 * status (a digest, a version line) is the caller's to read from the tail.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { KubeClient } from "../ports/kube.ts";

export interface JobRunOptions {
  signal: AbortSignal;
  pollMs?: number;
  /** Lines of log kept. */
  tailLines?: number;
}

export interface JobRun {
  result: "success" | "failed" | "cancelled";
  jobName: string;
  reason?: string;
  logTail: string;
}

interface JobStatus {
  metadata?: { name?: string };
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string }>;
  };
}

async function api<T>(kube: KubeClient, method: string, path: string, body?: unknown): Promise<T> {
  const res = await kube.request(method, path, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`kubernetes API ${method} ${path} returned ${res.status}: ${res.body.slice(0, 300)}`);
  }
  return JSON.parse(res.body) as T;
}

export async function runJob(
  kube: KubeClient,
  namespace: string,
  manifest: Record<string, unknown>,
  options: JobRunOptions,
): Promise<JobRun> {
  const ns = encodeURIComponent(namespace);
  const created = await api<JobStatus>(kube, "POST", `/apis/batch/v1/namespaces/${ns}/jobs`, manifest);
  const jobName = created.metadata?.name;
  if (!jobName) throw new Error("the created Job has no name");
  const path = `/apis/batch/v1/namespaces/${ns}/jobs/${encodeURIComponent(jobName)}`;
  let result: JobRun["result"] | null = null;
  let reason: string | undefined;
  while (result === null) {
    if (options.signal.aborted) {
      await kube.request("DELETE", `${path}?propagationPolicy=Background`);
      return { result: "cancelled", jobName, reason: "cancelled", logTail: "" };
    }
    const job = await api<JobStatus>(kube, "GET", path);
    const failed = job.status?.conditions?.find((c) => c.type === "Failed" && c.status === "True");
    if ((job.status?.succeeded ?? 0) > 0) result = "success";
    else if ((job.status?.failed ?? 0) > 0 || failed) {
      result = "failed";
      reason = failed?.reason ?? "the Job failed";
    } else {
      await sleep(options.pollMs ?? 2_000, undefined, { signal: options.signal }).catch(() => {});
    }
  }
  return {
    result,
    jobName,
    logTail: await tail(kube, ns, jobName, options.tailLines ?? 200),
    ...(reason ? { reason } : {}),
  };
}

async function tail(kube: KubeClient, ns: string, jobName: string, lines: number): Promise<string> {
  const pods = await api<{ items?: Array<{ metadata?: { name?: string } }> }>(
    kube,
    "GET",
    `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
  ).catch(() => ({ items: [] }));
  const pod = pods.items?.at(-1)?.metadata?.name;
  if (!pod) return "";
  const res = await kube.request(
    "GET",
    `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod)}/log?tailLines=${lines}`,
  );
  return res.status === 200 ? res.body : "";
}
