/**
 * The job queue. Workers claim queued jobs with a lease, renew it while they
 * work, and report the result. Every write is guarded: a job is claimed only
 * if it is still queued (FOR UPDATE SKIP LOCKED), and a result is accepted
 * only from the worker that still holds the lease on a running job. The
 * number of rows changed is the answer to "did I do this?".
 */
import { canTransition, type JobDef, type JobStatus } from "@stardust/core";
import type { Sql, TransactionSql } from "postgres";
import { advanceRun } from "./runs.ts";

export interface ClaimedJob {
  id: string;
  runId: string;
  name: string;
  attempt: number;
  projectId: string;
  ref: string;
  sha: string;
  def: JobDef;
}

export type JobResult = Extract<JobStatus, "success" | "failed" | "cancelled">;

/** Claims the oldest queued job, or returns null when there is none. */
export async function claimJob(
  sql: Sql | TransactionSql,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedJob | null> {
  const [row] = await sql<
    {
      id: string;
      run_id: string;
      name: string;
      attempt: number;
      project_id: string;
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
    SELECT claimed.*, runs.project_id, runs.ref, runs.sha, runs.def -> 'jobs' -> claimed.name AS job_def
    FROM claimed JOIN runs ON runs.id = claimed.run_id`;
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    attempt: row.attempt,
    projectId: row.project_id,
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
export async function finishJob(sql: Sql, jobId: string, workerId: string, result: JobResult): Promise<boolean> {
  if (!canTransition("running", result)) throw new Error(`running -> ${result} is not an allowed transition`);
  return sql.begin(async (tx) => {
    const [row] = await tx<{ run_id: string }[]>`
      UPDATE jobs SET status = ${result}, finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${workerId}
      RETURNING run_id`;
    if (!row) return false;
    await advanceRun(tx, row.run_id);
    return true;
  });
}

/**
 * Marks running jobs whose lease expired as `unknown` — their worker is gone —
 * and advances their runs. Returns how many jobs were reclaimed.
 */
export async function reclaimExpired(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ run_id: string }[]>`
      UPDATE jobs SET status = 'unknown', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
      WHERE status = 'running' AND lease_expires_at < now()
      RETURNING run_id`;
    for (const runId of [...new Set(rows.map((r) => r.run_id))].sort()) {
      await advanceRun(tx, runId);
    }
    return rows.length;
  });
}
