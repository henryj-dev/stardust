/**
 * Evaluating a pipeline definition: does an event start a run, which jobs
 * start first, which run next, which are skipped, and how a run ends.
 * Everything here is pure; the worker supplies events and job states.
 *
 * The semantics follow GitHub Actions where the format borrows from it:
 * `needs` requires every dependency to have *succeeded* (a skipped dependency
 * skips its dependents), and path filters apply to push events only.
 */
import type { JobDef, PipelineDef } from "./definition.ts";
import { isTerminal } from "./job-status.ts";

/**
 * Minimal GitHub Actions glob: `**` crosses directories, `*` and `?` do not.
 * Every other character is literal. Negation is not supported.
 */
function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchPath(pattern: string, path: string): boolean {
  return globToRegex(pattern).test(path);
}

/** True when no patterns are given, or when any path matches any pattern. */
export function anyPathMatches(patterns: readonly string[], paths: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  const regexes = patterns.map(globToRegex);
  return paths.some((p) => regexes.some((r) => r.test(p)));
}

export interface EventContext {
  branch?: string;
  tag?: string;
  /** Base branch of a pull request. */
  baseBranch?: string;
}

/**
 * Whether an event starts a run.
 * - no `on`: push only
 * - push: a tag push is judged by `on.push.tags` only; a branch push by
 *   `on.push.branches`, where an empty or missing list matches every branch
 * - pull_request: `on.pull_request.branches` against the base branch
 * - schedule: whether any schedule exists (the scheduler matches the cron)
 * - workflow_dispatch: whether it is declared
 */
export function evaluateOn(def: PipelineDef, event: string, ctx: EventContext): boolean {
  const on = def.on;
  if (!on) return event === "push";

  switch (event) {
    case "push": {
      if (!on.push) return false;
      if (ctx.tag !== undefined) {
        const tags = on.push.tags;
        const tag = ctx.tag;
        return !!tags && tags.length > 0 && tags.some((p) => matchPath(p, tag));
      }
      if (ctx.branch === undefined) return false;
      const branches = on.push.branches;
      const branch = ctx.branch;
      return !branches || branches.length === 0 || branches.some((p) => matchPath(p, branch));
    }
    case "pull_request": {
      if (!on.pull_request) return false;
      const branches = on.pull_request.branches;
      if (!branches || branches.length === 0) return true;
      const base = ctx.baseBranch;
      return base !== undefined && branches.some((p) => matchPath(p, base));
    }
    case "schedule":
      return Array.isArray(on.schedule) && on.schedule.length > 0;
    case "workflow_dispatch":
      return on.workflow_dispatch !== undefined && on.workflow_dispatch !== null;
    default:
      return false;
  }
}

/** Whether a job's path filter passes. Only push events are filtered. */
export function evaluatePaths(job: JobDef, event: string, changedPaths: readonly string[] | null): boolean {
  if (event !== "push") return true;
  const paths = job.if?.paths;
  if (!paths || paths.length === 0) return true;
  if (!changedPaths || changedPaths.length === 0) return false;
  return anyPathMatches(paths, changedPaths);
}

export function shouldSkipForPaths(job: JobDef, event: string, changedPaths: readonly string[] | null): boolean {
  return !evaluatePaths(job, event, changedPaths);
}

/** Jobs that start immediately: no `needs`, and their path filter passes. */
export function rootJobs(def: PipelineDef, event: string, changedPaths: readonly string[] | null): string[] {
  return Object.entries(def.jobs)
    .filter(([, job]) => !(job.needs && job.needs.length > 0) && evaluatePaths(job, event, changedPaths))
    .map(([name]) => name);
}

/** Jobs not created yet whose dependencies have all succeeded. */
export function nextReadyJobs(def: PipelineDef, statuses: ReadonlyMap<string, string>): string[] {
  return Object.entries(def.jobs)
    .filter(([name, job]) => !statuses.has(name) && (job.needs ?? []).every((d) => statuses.get(d) === "success"))
    .map(([name]) => name);
}

/**
 * Jobs not created yet to skip because a dependency ended without success.
 * Waits until every dependency has ended.
 */
export function shouldSkipForUpstream(def: PipelineDef, statuses: ReadonlyMap<string, string>): string[] {
  return Object.entries(def.jobs)
    .filter(([name, job]) => {
      if (statuses.has(name)) return false;
      const needs = job.needs ?? [];
      if (needs.length === 0) return false;
      return needs.every((d) => isTerminal(statuses.get(d))) && needs.some((d) => statuses.get(d) !== "success");
    })
    .map(([name]) => name);
}

/** A run is complete when every job in the definition has ended. */
export function isRunComplete(def: PipelineDef, statuses: ReadonlyMap<string, string>): boolean {
  return Object.keys(def.jobs).every((name) => isTerminal(statuses.get(name)));
}

/** failed (or unknown) wins over cancelled, which wins over success. */
export function aggregateRunStatus(
  def: PipelineDef,
  statuses: ReadonlyMap<string, string>,
): "success" | "failed" | "cancelled" {
  let failed = false;
  let cancelled = false;
  for (const name of Object.keys(def.jobs)) {
    const status = statuses.get(name);
    if (status === "failed" || status === "unknown") failed = true;
    if (status === "cancelled") cancelled = true;
  }
  if (failed) return "failed";
  if (cancelled) return "cancelled";
  return "success";
}
