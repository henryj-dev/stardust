/**
 * What plugins get from the database: their own migrations, the `database`
 * port, and claims on schedule runs.
 */
import { type Database, type Migration, migrationProblems } from "@stardust/core";
import type { Sql, TransactionSql } from "postgres";

/** The two databases: this region's, and the global one (the same one until there are several regions). */
export interface Databases {
  regional: Sql;
  global: Sql;
}

/**
 * Applies a plugin's pending migrations after stardust's, each in the
 * database of its scope, under the same lock. They are recorded as
 * `<plugin>/<name>` in that database, so a plugin's numbering is its own.
 */
export async function migratePlugin(
  databases: Databases,
  plugin: string,
  migrations: readonly Migration[],
): Promise<string[]> {
  const problems = migrationProblems(plugin, migrations);
  if (problems.length > 0) throw new Error(`plugin ${plugin}: ${problems.join("; ")}`);
  const ordered = [...migrations].sort((a, b) => (a.name < b.name ? -1 : 1));
  const applied: string[] = [];
  const targets: Sql[] =
    databases.global === databases.regional ? [databases.regional] : [databases.global, databases.regional];
  for (const sql of targets) {
    const mine = ordered.filter((m) =>
      targets.length === 1 ? true : sql === databases.global ? m.scope === "global" : m.scope === "regional",
    );
    if (mine.length === 0) continue;
    applied.push(
      ...(await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('stardust:migrate'))`;
        const done = new Set(
          (await tx<{ name: string }[]>`SELECT name FROM schema_migrations WHERE name LIKE ${`${plugin}/%`}`).map(
            (r) => r.name,
          ),
        );
        const now: string[] = [];
        for (const m of mine) {
          const name = `${plugin}/${m.name}`;
          if (done.has(name)) continue;
          await tx.unsafe(m.sql);
          await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
          now.push(name);
        }
        return now;
      })),
    );
  }
  return applied;
}

/** The `database` port over a postgres.js client. Nested transactions become savepoints. */
export function databasePort(sql: Sql): Database {
  const over = (q: Sql | TransactionSql, inTransaction: boolean): Database => ({
    // A plain array: callers never see the client's result object.
    query: async <T>(text: string, params: readonly unknown[] = []) => [
      ...((await q.unsafe(text, params as never[])) as unknown as T[]),
    ],
    transaction: <R>(work: (tx: Database) => Promise<R>) =>
      (inTransaction
        ? (q as TransactionSql).savepoint((tx) => work(over(tx, true)))
        : (q as Sql).begin((tx) => work(over(tx, true)))) as Promise<R>,
  });
  return over(sql, false);
}

/**
 * Claims the next run of a schedule for `holder`: only when the last run
 * started at least `everyMs` ago and no unexpired lease is held. True when
 * this caller should run it now.
 */
export async function claimScheduleRun(
  sql: Sql,
  name: string,
  holder: string,
  everyMs: number,
  leaseMs: number,
): Promise<boolean> {
  await sql`INSERT INTO schedule_runs (name) VALUES (${name}) ON CONFLICT DO NOTHING`;
  const claimed = await sql`
    UPDATE schedule_runs
       SET holder = ${holder},
           lease_until = clock_timestamp() + make_interval(secs => ${leaseMs / 1000}),
           last_started_at = clock_timestamp()
     WHERE name = ${name}
       AND (lease_until IS NULL OR lease_until < clock_timestamp())
       AND (last_started_at IS NULL OR last_started_at <= clock_timestamp() - make_interval(secs => ${everyMs / 1000}))
    RETURNING name`;
  return claimed.length === 1;
}

/** Ends a claimed run: frees the lease and records the error, if any. */
export async function finishScheduleRun(sql: Sql, name: string, holder: string, error: string | null): Promise<void> {
  await sql`
    UPDATE schedule_runs
       SET holder = NULL, lease_until = NULL, last_finished_at = clock_timestamp(),
           last_error = ${error === null ? null : error.slice(0, 2000)}
     WHERE name = ${name} AND holder = ${holder}`;
}
