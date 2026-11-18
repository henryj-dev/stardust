/**
 * Runs a Kubernetes Job to its end through the kube port: create it (or take
 * over the one an earlier attempt of the same job left running), poll until it
 * succeeds or fails (deleting it when the job is cancelled), and keep the last
 * lines of its pod's log. What success means beyond the Job's own status (a
 * digest, a version line) is the caller's to read from the tail.
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

/**
 * The reason a worker aborts a job it no longer holds because another worker
 * will carry it on (the job was queued again after the worker's lease expired).
 * Unlike a cancellation, the Kubernetes Job is left running for that worker.
 */
export class LeaseHandoff extends Error {
  constructor() {
    super("the job was handed to another worker");
    this.name = "LeaseHandoff";
  }
}

/** Whether an abort means "stop watching, leave the Job" rather than "cancel it". */
export const isHandoff = (signal: AbortSignal): boolean => signal.reason instanceof LeaseHandoff;

interface ListedJob {
  metadata?: { name?: string; uid?: string; creationTimestamp?: string; deletionTimestamp?: string };
  spec?: { suspend?: boolean };
}

/**
 * The Job an earlier attempt of the same stardust job left behind, found by its
 * `stardust/run` and `stardust/job` labels: the newest one that is not being
 * deleted and was released (not suspended). A suspended leftover never got what
 * it needed to start and is deleted. Null when there is none, or the manifest
 * has no such labels, and a new Job is made.
 */
export async function adoptableJob(
  kube: KubeClient,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ name: string; uid: string } | null> {
  const labels = (manifest.metadata as { labels?: Record<string, string> } | undefined)?.labels ?? {};
  const run = labels["stardust/run"];
  const job = labels["stardust/job"];
  if (!run || !job) return null;
  const ns = encodeURIComponent(namespace);
  const selector = encodeURIComponent(`stardust/run=${run},stardust/job=${job}`);
  const res = await kube.request("GET", `/apis/batch/v1/namespaces/${ns}/jobs?labelSelector=${selector}`);
  if (res.status < 200 || res.status >= 300) return null;
  const items = ((JSON.parse(res.body) as { items?: ListedJob[] }).items ?? []).filter(
    (j) => j.metadata?.name && !j.metadata.deletionTimestamp,
  );
  for (const j of items.filter((x) => x.spec?.suspend)) {
    await kube.request(
      "DELETE",
      `/apis/batch/v1/namespaces/${ns}/jobs/${encodeURIComponent(j.metadata?.name ?? "")}?propagationPolicy=Background`,
    );
  }
  const live = items
    .filter((j) => !j.spec?.suspend)
    .sort((a, b) => (a.metadata?.creationTimestamp ?? "").localeCompare(b.metadata?.creationTimestamp ?? ""));
  const newest = live.at(-1)?.metadata;
  return newest?.name ? { name: newest.name, uid: newest.uid ?? "" } : null;
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
  const adopted = await adoptableJob(kube, namespace, manifest);
  const jobName = adopted
    ? adopted.name
    : (await api<JobStatus>(kube, "POST", `/apis/batch/v1/namespaces/${ns}/jobs`, manifest)).metadata?.name;
  if (!jobName) throw new Error("the created Job has no name");
  const path = `/apis/batch/v1/namespaces/${ns}/jobs/${encodeURIComponent(jobName)}`;
  let result: JobRun["result"] | null = null;
  let reason: string | undefined;
  while (result === null) {
    if (options.signal.aborted) {
      if (isHandoff(options.signal)) return { result: "cancelled", jobName, reason: "handed off", logTail: "" };
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
