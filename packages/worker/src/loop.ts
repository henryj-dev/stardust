/**
 * The worker loop: claim a job, keep its lease alive while a handler runs it,
 * then record the result. If the lease is lost (the job was reclaimed or
 * cancelled), the handler's signal is aborted and the result is discarded —
 * another worker or the reclaimer owns the job now.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@stardust/core";
import {
  type ClaimedJob,
  claimJob,
  finishJob,
  type JobResult,
  reclaimExpired,
  renewLease,
  type Sql,
} from "@stardust/db";

/** A handler returns the result, optionally with details stored on the job (build Job name, digest, reason). */
export type HandlerOutcome = JobResult | { result: JobResult; detail?: Record<string, unknown> };
export type JobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<HandlerOutcome>;

export interface WorkerOptions {
  sql: Sql;
  workerId: string;
  handler: JobHandler;
  log: Logger;
  /** How long a claim stays valid without renewal. */
  leaseMs?: number;
  /** Pause between polls when the queue is empty. */
  idleMs?: number;
  /** Stops the loop after the current job. */
  signal: AbortSignal;
}

/** Runs one claimed job to completion. Returns the recorded result, or null if the lease was lost. */
export async function runJob(
  opts: Pick<WorkerOptions, "sql" | "workerId" | "handler" | "log"> & { leaseMs: number },
  job: ClaimedJob,
): Promise<JobResult | null> {
  const { sql, workerId, handler, log, leaseMs } = opts;
  const lost = new AbortController();
  const renew = setInterval(
    () => {
      renewLease(sql, job.id, workerId, leaseMs).then(
        (held) => {
          if (!held) lost.abort(new Error("lease lost"));
        },
        (err: unknown) => log.warn("lease renewal failed", { job: job.id, error: String(err) }),
      );
    },
    Math.max(50, Math.floor(leaseMs / 3)),
  );

  let result: JobResult;
  let detail: Record<string, unknown> = {};
  try {
    const outcome = await handler(job, lost.signal);
    if (typeof outcome === "string") result = outcome;
    else {
      result = outcome.result;
      detail = outcome.detail ?? {};
    }
  } catch (err) {
    log.error("job handler threw", { job: job.id, name: job.name, error: String(err) });
    result = "failed";
    detail = { reason: String(err) };
  } finally {
    clearInterval(renew);
  }

  if (lost.signal.aborted || !(await finishJob(sql, job.id, workerId, result, detail))) {
    log.warn("lease lost; result discarded", { job: job.id, name: job.name, result });
    return null;
  }
  log.info("job finished", { job: job.id, name: job.name, result });
  return result;
}

/** Claims and runs jobs until `signal` is aborted. */
export async function runWorker(opts: WorkerOptions): Promise<void> {
  const leaseMs = opts.leaseMs ?? 30_000;
  const idleMs = opts.idleMs ?? 1_000;
  let lastReclaim = 0;
  while (!opts.signal.aborted) {
    if (Date.now() - lastReclaim > leaseMs) {
      const reclaimed = await reclaimExpired(opts.sql);
      if (reclaimed > 0) opts.log.warn("reclaimed jobs with expired leases", { count: reclaimed });
      lastReclaim = Date.now();
    }
    const job = await claimJob(opts.sql, opts.workerId, leaseMs);
    if (!job) {
      await sleep(idleMs, undefined, { signal: opts.signal }).catch(() => {});
      continue;
    }
    await runJob({ ...opts, leaseMs }, job);
  }
}
