/** How a run's page shows a job: its timing and what it recorded. */

/** A job that may still print or change. */
export function isActive(status: string): boolean {
  return status === "queued" || status === "running";
}

/** "1m 39s" from start to finish, or to `now` while it runs; null before it starts. */
export function duration(startedAt: string | null, finishedAt: string | null, now = Date.now()): string | null {
  if (!startedAt) return null;
  const end = finishedAt ? Date.parse(finishedAt) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface JobFact {
  key: string;
  label: string;
  value: string;
}

// What a job's detail may hold, in the order it is shown.
const FACTS: Array<[key: string, label: string]> = [
  ["reason", "Why it failed"],
  ["digest", "Image digest"],
  ["buildJob", "Build job"],
  ["deployCommit", "Deploy commit"],
  ["deploy", "Deploy"],
];

/** The detail's known fields that are present, as text. The kept log tail is shown apart. */
export function jobFacts(detail: Record<string, unknown>): JobFact[] {
  return FACTS.flatMap(([key, label]) => {
    const value = detail[key];
    return typeof value === "string" && value !== "" ? [{ key, label, value }] : [];
  });
}

/** The last lines the worker kept from a failed build, if any. */
export function keptLogTail(detail: Record<string, unknown>): string | null {
  return typeof detail.logTail === "string" && detail.logTail !== "" ? detail.logTail : null;
}
