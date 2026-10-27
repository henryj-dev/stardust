/**
 * Job states and the transitions between them. This is the only place that
 * defines them: the queue, the DAG evaluation and the watcher all read the
 * same sets, so adding a state means editing this file only.
 *
 * Spelling matters: the terminal state is `cancelled` (two l's). A misspelt
 * state would never be seen as terminal and a run would never finish.
 */

export const JOB_STATUSES = ["queued", "running", "success", "failed", "unknown", "skipped", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** States a job never leaves. `unknown` means the build's workload disappeared. */
export const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "success",
  "failed",
  "unknown",
  "skipped",
  "cancelled",
]);

/**
 * Allowed transitions.
 * - queued → running (claimed), cancelled (by an operator) or failed (could not start)
 * - running → success, failed, unknown or cancelled
 * - skipped is only ever written when a job is created; terminal states are final.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["success", "failed", "unknown", "cancelled"],
  success: [],
  failed: [],
  unknown: [],
  skipped: [],
  cancelled: [],
};

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(value: string | null | undefined): boolean {
  return isJobStatus(value) && TERMINAL.has(value);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
