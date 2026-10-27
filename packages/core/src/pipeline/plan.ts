/**
 * What a run would do, without doing it: the shadow mode that compares a new
 * installation's decisions with an existing system's.
 *
 * `nextJobs` is the one step that both a real run (packages/db advanceRun) and
 * a plan take, so a plan cannot drift from what a run does.
 */
import { nextReadyJobs, shouldSkipForPaths, shouldSkipForUpstream } from "./dag.ts";
import type { PipelineDef } from "./definition.ts";

export interface NewJob {
  name: string;
  status: "queued" | "skipped";
}

/** The jobs to create now, given the statuses of the ones that exist. */
export function nextJobs(
  def: PipelineDef,
  event: string,
  changedPaths: readonly string[] | null,
  statuses: ReadonlyMap<string, string>,
): NewJob[] {
  const create: NewJob[] = [];
  for (const name of shouldSkipForUpstream(def, statuses)) create.push({ name, status: "skipped" });
  for (const name of nextReadyJobs(def, statuses)) {
    const job = def.jobs[name];
    const skip = job !== undefined && shouldSkipForPaths(job, event, changedPaths);
    create.push({ name, status: skip ? "skipped" : "queued" });
  }
  return create;
}

/**
 * Every job's fate when each job that runs succeeds: "run" or "skip". Jobs that
 * would only be skipped because something upstream failed cannot be planned;
 * a plan assumes success.
 */
export function planRun(
  def: PipelineDef,
  event: string,
  changedPaths: readonly string[] | null,
): Record<string, "run" | "skip"> {
  const statuses = new Map<string, string>();
  for (;;) {
    const create = nextJobs(def, event, changedPaths, statuses);
    if (create.length === 0) break;
    for (const job of create) statuses.set(job.name, job.status === "queued" ? "success" : "skipped");
  }
  return Object.fromEntries(
    Object.keys(def.jobs)
      .sort()
      .map((name) => [name, statuses.get(name) === "success" ? "run" : "skip"]),
  );
}
