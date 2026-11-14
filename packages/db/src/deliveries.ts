/**
 * What was delivered, and taking it back: successful build jobs that pointed
 * the deploy repository at an image, newest first; and cancelling a job that
 * has not finished.
 */
import type { Sql } from "postgres";
import { advanceRun } from "./runs.ts";

export interface Delivery {
  jobId: string;
  runId: string;
  /** The commit that was built. */
  sha: string;
  digest: string;
  deployCommit: string | null;
  finishedAt: string;
}

/**
 * Successful deliveries of one component, newest first. A job names its
 * component in its definition; in a project with one component, a job that
 * names none is that component's.
 */
export async function listDeliveries(
  sql: Sql,
  projectId: string,
  component: string,
  onlyComponent: boolean,
  limit = 50,
): Promise<Delivery[]> {
  const rows = await sql<
    {
      id: string;
      run_id: string;
      sha: string;
      digest: string;
      deploy_commit: string | null;
      finished_at: Date;
    }[]
  >`
    SELECT j.id, j.run_id, r.sha, j.detail->>'digest' AS digest, j.detail->>'deployCommit' AS deploy_commit,
           j.finished_at
      FROM jobs j JOIN runs r ON r.id = j.run_id
     WHERE r.project_id = ${projectId} AND j.status = 'success' AND j.detail ? 'digest'
       AND r.event <> 'pull_request'
       AND (r.def->'jobs'->j.name->>'component' = ${component}
            OR (${onlyComponent} AND r.def->'jobs'->j.name->>'component' IS NULL))
     ORDER BY j.finished_at DESC, j.id DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    jobId: r.id,
    runId: r.run_id,
    sha: r.sha,
    digest: r.digest,
    deployCommit: r.deploy_commit,
    finishedAt: r.finished_at.toISOString(),
  }));
}

/**
 * Cancels a job that is queued or running, and advances its run. A running
 * job's worker loses its lease at the next renewal and stops the build.
 * False when the job had already finished (or does not exist).
 */
export async function cancelJob(sql: Sql, runId: string, jobName: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ run_id: string }[]>`
      UPDATE jobs SET status = 'cancelled', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
        detail = jobs.detail || '{"reason": "cancelled by an operator"}'::jsonb
      WHERE run_id = ${runId} AND name = ${jobName} AND status IN ('queued', 'running')
      RETURNING run_id`;
    if (!row) return false;
    await advanceRun(tx, row.run_id);
    return true;
  });
}
