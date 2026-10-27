/**
 * Runs: starting one from a pipeline definition and advancing it as jobs end.
 *
 * Which job comes next is decided by packages/core (dag.ts); this module only
 * stores the outcome. A job that does not exist yet has simply not been
 * created — that is what the core functions expect.
 */
import { aggregateRunStatus, isRunComplete, loadPipelineDef, nextJobs, type PipelineDef } from "@stardust/core";
import type { Sql, TransactionSql } from "postgres";

export interface StartRun {
  projectId: string;
  event: string;
  trigger: string;
  ref: string;
  sha: string;
  def: unknown;
  /** Changed paths of a push, for path filters; null when not known. */
  changedPaths: readonly string[] | null;
}

/** Creates a run and its first jobs. Throws PipelineDefError on an invalid definition. */
export async function startRun(sql: Sql, input: StartRun): Promise<string> {
  const def = loadPipelineDef(input.def);
  return sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      INSERT INTO runs (project_id, event, trigger, ref, sha, def, changed_paths)
      VALUES (${input.projectId}, ${input.event}, ${input.trigger}, ${input.ref}, ${input.sha},
              ${tx.json(def as never)}, ${input.changedPaths === null ? null : tx.array([...input.changedPaths])})
      RETURNING id`;
    if (!run) throw new Error("run insert returned no row");
    await advanceRun(tx, run.id);
    return run.id;
  });
}

/**
 * Brings a run up to date after a job ended: creates jobs that are now ready
 * (queued, or skipped by their path filter), skips jobs whose dependencies
 * ended without success, repeats until nothing changes, and closes the run
 * when every job has ended. Locks the run row, so concurrent completions in
 * one run are applied one after another and never create a job twice.
 */
export async function advanceRun(tx: TransactionSql, runId: string): Promise<void> {
  const [run] = await tx<{ def: PipelineDef; event: string; changed_paths: string[] | null; status: string }[]>`
    SELECT def, event, changed_paths, status FROM runs WHERE id = ${runId} FOR UPDATE`;
  if (run?.status !== "running") return;
  const { def, event } = run;

  for (;;) {
    const rows = await tx<{ name: string; status: string }[]>`SELECT name, status FROM jobs WHERE run_id = ${runId}`;
    const statuses = new Map(rows.map((r) => [r.name, r.status]));
    const create = nextJobs(def, event, run.changed_paths, statuses);
    if (create.length === 0) {
      if (isRunComplete(def, statuses)) {
        await tx`UPDATE runs SET status = ${aggregateRunStatus(def, statuses)}, finished_at = now()
                 WHERE id = ${runId}`;
      }
      return;
    }
    for (const job of create) {
      await tx`
        INSERT INTO jobs (run_id, name, status, finished_at)
        VALUES (${runId}, ${job.name}, ${job.status}, ${job.status === "skipped" ? tx`now()` : null})
        ON CONFLICT (run_id, name) DO NOTHING`;
    }
  }
}

/**
 * Claims a webhook delivery ID; false when it was already claimed, meaning
 * this is a re-sent copy. Claims older than 30 days are dropped.
 */
export async function claimDelivery(sql: Sql, deliveryId: string, projectId: string): Promise<boolean> {
  if (Math.random() < 0.01) await sql`DELETE FROM webhook_deliveries WHERE received_at < now() - interval '30 days'`;
  const rows = await sql`
    INSERT INTO webhook_deliveries (delivery_id, project_id) VALUES (${deliveryId}, ${projectId})
    ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`;
  return rows.length === 1;
}

/** Gives a claim back, when the run it was for could not be started. */
export async function releaseDelivery(sql: Sql, deliveryId: string): Promise<void> {
  await sql`DELETE FROM webhook_deliveries WHERE delivery_id = ${deliveryId}`;
}
