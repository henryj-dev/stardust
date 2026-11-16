// Durable replay ledger for delete approval tickets, backed by PostgreSQL.
//
// A signed ticket is only single-use if every replica, before and after a restart, agrees on
// which `jti` values were already spent. The in-process guard in `policy.ts` cannot do that,
// so a real deployment uses this table (see `migrations/001_approval_replay.sql`).
//
// The table's CHECK constraint admits a `create-rollback` purpose as well, but the broker
// only issues and accepts `instance-destroy`. Allowing a value in the schema is not a
// reason to use it; see the note at the top of `policy.ts`.

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { ApprovalClaims, ApprovalReplayLease, ApprovalReplayStore } from "./policy.ts";

export const APPROVAL_REPLAY_SCHEMA_CHECK_SQL = `
SELECT
  to_regclass('public.vultr_broker_approval_replays') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vultr_broker_approval_replays'
      AND c.contype = 'p'
      AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (jti)'
  )
  AND (
    SELECT COUNT(*) = 9
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'vultr_broker_approval_replays'
      AND column_name IN ('jti', 'purpose', 'target', 'actor', 'expires_at', 'state', 'claim_token', 'updated_at', 'created_at')
  ) AS ready`;

export const APPROVAL_REPLAY_CLAIM_SQL = `
INSERT INTO vultr_broker_approval_replays
  (jti, purpose, target, actor, expires_at, state, claim_token, updated_at)
VALUES ($1::uuid, $2, $3::uuid, $4, to_timestamp($5), 'processing', $6::uuid, to_timestamp($7))
ON CONFLICT (jti) DO UPDATE
SET claim_token = EXCLUDED.claim_token, updated_at = EXCLUDED.updated_at
WHERE vultr_broker_approval_replays.state = 'processing'
  AND vultr_broker_approval_replays.purpose = EXCLUDED.purpose
  AND vultr_broker_approval_replays.target = EXCLUDED.target
  AND vultr_broker_approval_replays.actor = EXCLUDED.actor
  AND vultr_broker_approval_replays.expires_at = EXCLUDED.expires_at
  AND vultr_broker_approval_replays.expires_at > to_timestamp($7)
  AND vultr_broker_approval_replays.updated_at <= to_timestamp($7) - ($8 * INTERVAL '1 second')
RETURNING claim_token::text`;

export const APPROVAL_REPLAY_PRUNE_SQL = `
DELETE FROM vultr_broker_approval_replays
WHERE jti IN (
  SELECT jti
  FROM vultr_broker_approval_replays
  WHERE expires_at < to_timestamp($1) - INTERVAL '1 day'
  ORDER BY expires_at, jti
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
)`;

/** The one method the store needs. */
export type SqlLike = {
  unsafe<T = unknown>(query: string, values?: unknown[]): PromiseLike<T>;
};

/** Adapts a postgres.js client: its `sql.unsafe(text, params)` is the same call, typed more narrowly. */
export function fromPostgres(sql: postgres.Sql): SqlLike {
  return {
    unsafe: <T>(query: string, values?: unknown[]) =>
      sql.unsafe(query, values as postgres.ParameterOrJSON<never>[]) as unknown as PromiseLike<T>,
  };
}

type ClaimRow = { claim_token: string };
type ReadyRow = { ready: boolean };

export function requireReplayDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error("VULTR_REPLAY_DATABASE_URL is required for durable approval replay");
  return value;
}

/**
 * Replay gate shared across processes. A short processing lease allows a retry when a
 * replica dies before it reaches Vultr; a consumed row stays authoritative for the whole
 * lifetime of the signed ticket.
 */
export class PostgresApprovalReplayStore implements ApprovalReplayStore {
  private readonly sql: SqlLike;
  private readonly processingLeaseSeconds: number;

  constructor(sql: SqlLike, processingLeaseSeconds = 30) {
    this.sql = sql;
    this.processingLeaseSeconds = processingLeaseSeconds;
    if (!Number.isInteger(processingLeaseSeconds) || processingLeaseSeconds < 1) {
      throw new Error("processing lease must be a positive integer");
    }
  }

  async initialize(): Promise<void> {
    const rows = await this.sql.unsafe<ReadyRow[]>(APPROVAL_REPLAY_SCHEMA_CHECK_SQL);
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new Error("vultr broker replay schema is missing or invalid");
    }
  }

  async claim(claims: ApprovalClaims, now: number): Promise<ApprovalReplayLease> {
    // Expired tickets cannot pass verifyApproval. Keeping rows one extra day leaves a generous
    // window for clock skew and audits while keeping the table bounded.
    await this.sql.unsafe(APPROVAL_REPLAY_PRUNE_SQL, [now]);
    const claimToken = randomUUID();
    const rows = await this.sql.unsafe<ClaimRow[]>(APPROVAL_REPLAY_CLAIM_SQL, [
      claims.jti,
      claims.purpose,
      claims.target,
      claims.actor,
      claims.exp,
      claimToken,
      now,
      this.processingLeaseSeconds,
    ]);
    if (rows.length !== 1 || rows[0]?.claim_token !== claimToken) return { ok: false };

    return {
      ok: true,
      consume: async () => {
        const settled = await this.sql.unsafe<Array<{ jti: string }>>(
          `UPDATE vultr_broker_approval_replays
           SET state = 'consumed', updated_at = NOW()
           WHERE jti = $1::uuid AND state = 'processing' AND claim_token = $2::uuid
           RETURNING jti::text`,
          [claims.jti, claimToken],
        );
        if (settled.length !== 1) throw new Error("approval replay lease lost before consume");
      },
      release: async () => {
        const released = await this.sql.unsafe<Array<{ jti: string }>>(
          `DELETE FROM vultr_broker_approval_replays
           WHERE jti = $1::uuid AND state = 'processing' AND claim_token = $2::uuid
           RETURNING jti::text`,
          [claims.jti, claimToken],
        );
        if (released.length !== 1) throw new Error("approval replay lease lost before release");
      },
    };
  }
}
