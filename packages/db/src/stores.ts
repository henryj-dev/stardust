/** The `sagas` and `guards` ports, in PostgreSQL. */
import type { GuardStore, SagaRecord, SagaStatus, SagaStore } from "@stardust/core";
import type { Sql } from "postgres";

interface SagaRow {
  id: string;
  kind: string;
  status: SagaStatus;
  state: unknown;
  done: string[];
  failed_step: string | null;
  error: string | null;
}

const fromRow = (r: SagaRow): SagaRecord => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  state: r.state,
  done: r.done,
  failedStep: r.failed_step,
  error: r.error,
});

export function sagaStore(sql: Sql): SagaStore {
  return {
    async create(record) {
      await sql`
        INSERT INTO saga_runs (id, kind, status, state, done, failed_step, error)
        VALUES (${record.id}, ${record.kind}, ${record.status}, ${sql.json(record.state as never)},
                ${record.done}, ${record.failedStep}, ${record.error})`;
    },
    async load(id) {
      const [row] = await sql<SagaRow[]>`
        SELECT id, kind, status, state, done, failed_step, error FROM saga_runs WHERE id = ${id}`;
      return row ? fromRow(row) : null;
    },
    async save(record) {
      const updated = await sql`
        UPDATE saga_runs
           SET status = ${record.status}, state = ${sql.json(record.state as never)}, done = ${record.done},
               failed_step = ${record.failedStep}, error = ${record.error}, updated_at = now()
         WHERE id = ${record.id}`;
      if (updated.count !== 1) throw new Error(`no saga ${record.id} to save`);
    },
  };
}

/**
 * Used ids are global, so an approval ticket cannot be used once in each
 * region; counted events are regional.
 */
export function guardStore(sql: Sql, globalSql: Sql = sql): GuardStore {
  return {
    async useOnce(scope, id, expiresAt) {
      const rows = await globalSql`
        INSERT INTO guard_used (scope, id, expires_at) VALUES (${scope}, ${id}, ${expiresAt})
        ON CONFLICT DO NOTHING RETURNING id`;
      return rows.length === 1;
    },
    async count(scope, key, windowMs) {
      const [row] = await sql<{ n: number }[]>`
        WITH added AS (INSERT INTO guard_events (scope, key) VALUES (${scope}, ${key}) RETURNING at)
        SELECT 1 + count(*)::int AS n FROM guard_events
         WHERE scope = ${scope} AND key = ${key}
           AND at > clock_timestamp() - make_interval(secs => ${windowMs / 1000})`;
      return row?.n ?? 1;
    },
  };
}

/** Forgets used ids past their expiry and events older than a day. */
export async function purgeGuards(sql: Sql, globalSql: Sql = sql): Promise<number> {
  const used = await globalSql`DELETE FROM guard_used WHERE expires_at < now()`;
  const events = await sql`DELETE FROM guard_events WHERE at < now() - interval '1 day'`;
  return used.count + events.count;
}
