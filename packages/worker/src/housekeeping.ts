/**
 * Periodic upkeep next to the job loop: the audit log keeps its retention
 * here. Several workers may purge at once; a DELETE by age is idempotent.
 */
import type { Logger } from "@stardust/core";
import { purgeAudit, purgeGuards, type Sql } from "@stardust/db";

export interface HousekeepingOptions {
  sql: Sql;
  /** Where the audit log and used tickets live; `sql` when there is one database. */
  globalSql?: Sql;
  log: Logger;
  /** Days of audit events to keep; 0 keeps them all. */
  auditRetentionDays: number;
  /** Between purges; hourly by default. The first runs right away. */
  everyMs?: number;
  signal: AbortSignal;
}

export async function purgeOnce(
  opts: Pick<HousekeepingOptions, "sql" | "globalSql" | "log" | "auditRetentionDays">,
): Promise<number> {
  try {
    const removed = await purgeAudit(opts.globalSql ?? opts.sql, opts.auditRetentionDays);
    if (removed > 0)
      opts.log.info("removed old audit events", { count: removed, retentionDays: opts.auditRetentionDays });
    return removed;
  } catch (err) {
    opts.log.warn("purging the audit log failed", { error: (err as Error).message });
    return 0;
  }
}

/** Forgets expired approval tickets and old guard events. */
async function purgeGuardsOnce(opts: Pick<HousekeepingOptions, "sql" | "globalSql" | "log">): Promise<void> {
  try {
    await purgeGuards(opts.sql, opts.globalSql ?? opts.sql);
  } catch (err) {
    opts.log.warn("purging guard records failed", { error: (err as Error).message });
  }
}

/** Purges now and then every `everyMs` until the signal is aborted. */
export function startHousekeeping(opts: HousekeepingOptions): void {
  const keepAudit = opts.auditRetentionDays === 0;
  if (keepAudit) opts.log.info("audit events are kept forever (audit.retentionDays is 0)");
  const once = () => {
    if (!keepAudit) void purgeOnce(opts);
    void purgeGuardsOnce(opts);
  };
  once();
  const timer = setInterval(once, opts.everyMs ?? 3_600_000);
  timer.unref();
  opts.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
