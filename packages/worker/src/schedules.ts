/**
 * Runs the plugins' schedules. Every few seconds each worker tries to claim
 * each schedule's next run; the claim is one UPDATE, so across workers a
 * schedule runs at most once per interval. A run gets its lease's length to
 * finish, then its signal is aborted.
 */
import type { Feature, Logger } from "@stardust/core";
import { claimScheduleRun, finishScheduleRun, type Sql } from "@stardust/db";

export interface ScheduleOptions {
  sql: Sql;
  features: readonly Feature[];
  /** This worker, as the lease names it. */
  holder: string;
  log: Logger;
  signal: AbortSignal;
  /** How often to look for due runs. */
  tickMs?: number;
}

/** Tries every schedule once; returns the names it ran. */
export async function runDueSchedules(options: Omit<ScheduleOptions, "tickMs">): Promise<string[]> {
  const ran: string[] = [];
  for (const feature of options.features) {
    for (const schedule of feature.schedules) {
      if (options.signal.aborted) return ran;
      const name = `${feature.plugin}.${schedule.id}`;
      const leaseMs = Math.max(schedule.everyMs, 60_000);
      let claimed = false;
      try {
        claimed = await claimScheduleRun(options.sql, name, options.holder, schedule.everyMs, leaseMs);
      } catch (err) {
        options.log.warn("claiming a schedule failed", { schedule: name, error: (err as Error).message });
      }
      if (!claimed) continue;
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(leaseMs)]);
      let error: string | null = null;
      try {
        await schedule.run({ ...feature.context, signal });
      } catch (err) {
        error = (err as Error).message;
        options.log.error("a schedule failed", { schedule: name, error });
      }
      await finishScheduleRun(options.sql, name, options.holder, error).catch((err: Error) =>
        options.log.warn("recording a schedule run failed", { schedule: name, error: err.message }),
      );
      ran.push(name);
    }
  }
  return ran;
}

export function startSchedules(options: ScheduleOptions): void {
  if (!options.features.some((f) => f.schedules.length > 0)) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueSchedules(options);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.tickMs ?? 5_000);
  timer.unref();
  options.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
