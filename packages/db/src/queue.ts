/**
 * The job queue. Workers claim queued jobs with a lease, renew it while they
 * work, and report the result. Every write is guarded: a job is claimed only
 * if it is still queued (FOR UPDATE SKIP LOCKED), and a result is accepted
 * only from the worker that still holds the lease on a running job. The
 * number of rows changed is the answer to "did I do this?".
 */
import { canTransition, isTerminal, type JobDef, type JobStatus } from "@stardust/core";
import type { Sql, TransactionSql } from "postgres";
import { advanceRun } from "./runs.ts";

export interface ClaimedJob {
  id: string;
  runId: string;
  name: string;
  attempt: number;
  projectId: string;
  /** The run's event: push, pull_request, workflow_dispatch… */
  event: string;
  ref: string;
  sha: string;
  def: JobDef;
}

export type JobResult = Extract<JobStatus, "success" | "failed" | "cancelled">;

/**
 * Claims the oldest queued job, or returns null when there is none — or when
 * `maxRunning` jobs already run across all workers (0: no limit). With a
 * limit, claims are serialised so two workers cannot both take the last slot.
 */
export async function claimJob(
  sql: Sql | TransactionSql,
  workerId: string,
  leaseMs: number,
  maxRunning = 0,
): Promise<ClaimedJob | null> {
  if (maxRunning > 0) {
    if (!("begin" in sql)) throw new Error("a limited claim needs its own transaction");
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('stardust:claim'))`;
      const [running] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE status = 'running'`;
      if ((running?.n ?? 0) >= maxRunning) return null;
      return claimJob(tx, workerId, leaseMs);
    });
  }
  const [row] = await sql<
    {
      id: string;
      run_id: string;
      name: string;
      attempt: number;
      project_id: string;
      event: string;
      ref: string;
      sha: string;
      job_def: JobDef;
    }[]
  >`
    WITH next AS (
      SELECT id FROM jobs WHERE status = 'queued'
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE jobs SET
        status = 'running',
        attempt = jobs.attempt + 1,
        lease_owner = ${workerId},
        lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
        started_at = now()
      FROM next WHERE jobs.id = next.id
      RETURNING jobs.id, jobs.run_id, jobs.name, jobs.attempt
    )
    SELECT claimed.*, runs.project_id, runs.event, runs.ref, runs.sha, runs.def -> 'jobs' -> claimed.name AS job_def
    FROM claimed JOIN runs ON runs.id = claimed.run_id`;
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    attempt: row.attempt,
    projectId: row.project_id,
    event: row.event,
    ref: row.ref,
    sha: row.sha,
    def: row.job_def,
  };
}

/** Extends the lease. False means the lease was lost and the work must stop. */
export async function renewLease(sql: Sql, jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
  const rows = await sql`
    UPDATE jobs SET lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${workerId}
    RETURNING id`;
  return rows.length === 1;
}

/**
 * Records a result and advances the run. False means this worker no longer
 * holds the job (lease expired and reclaimed, or cancelled) and nothing changed.
 */
export async function finishJob(
  sql: Sql,
  jobId: string,
  workerId: string,
  result: JobResult,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  if (!isTerminal(result) || !canTransition("running", result))
    throw new Error(`running -> ${result} is not an allowed transition for a result`);
  return sql.begin(async (tx) => {
    const [row] = await tx<{ run_id: string }[]>`
      UPDATE jobs SET status = ${result}, finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
        detail = jobs.detail || ${tx.json(detail as never)}
      WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${workerId}
      RETURNING run_id`;
    if (!row) return false;
    await advanceRun(tx, row.run_id);
    return true;
  });
}

/** Attempts a job gets before a stopped worker is taken as its end: the first and two take-overs. */
export const MAX_ATTEMPTS = 3;

/**
 * Takes back running jobs whose lease expired: their worker stopped (restarted,
 * evicted, rolled to a new version), which says nothing about the work itself —
 * a build Job usually runs on. Such a job is queued again, and the next worker
 * takes over the Job the last attempt left (see `adoptableJob` in core) instead
 * of building again. After MAX_ATTEMPTS it is marked `unknown`, with the reason,
 * and its run advances. Returns how many jobs were taken back.
 */
export async function reclaimExpired(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const requeued = await tx<{ id: string }[]>`
      UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
        detail = jobs.detail || jsonb_build_object('reclaimed', jsonb_build_object('at', now(), 'attempt', jobs.attempt))
      WHERE status = 'running' AND lease_expires_at < now() AND attempt < ${MAX_ATTEMPTS}
      RETURNING id`;
    const lost = await tx<{ run_id: string }[]>`
      UPDATE jobs SET status = 'unknown', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
        detail = jobs.detail || jsonb_build_object('reason',
          format('the worker running it stopped %s times (its lease expired); the build Job may still have finished', jobs.attempt))
      WHERE status = 'running' AND lease_expires_at < now()
      RETURNING run_id`;
    for (const runId of [...new Set(lost.map((r) => r.run_id))].sort()) {
      await advanceRun(tx, runId);
    }
    return requeued.length + lost.length;
  });
}

/** The status of a job, or null when it does not exist. */
export async function jobStatusOf(sql: Sql, jobId: string): Promise<string | null> {
  const [row] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}`;
  return row?.status ?? null;
}
