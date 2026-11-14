// Tests for the durable replay ledger, against an in-memory fake of its SQL. The same
// behavior against a real PostgreSQL is in approval-replay-store.dbtest.ts.
//
// Every fixture uses the `instance-destroy` purpose. The table's CHECK constraint admits
// `create-rollback` too, but the broker never issues it; a test that kept using it would read
// as if the feature existed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVAL_REPLAY_CLAIM_SQL,
  APPROVAL_REPLAY_PRUNE_SQL,
  APPROVAL_REPLAY_SCHEMA_CHECK_SQL,
  PostgresApprovalReplayStore,
  requireReplayDatabaseUrl,
} from "./approval-replay-store.ts";
import type { ApprovalClaims } from "./policy.ts";

const CLAIMS: ApprovalClaims = {
  v: 1,
  purpose: "instance-destroy",
  target: "6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d",
  actor: "user-1",
  jti: "12345678-1234-4234-9234-123456789012",
  iat: 1_700_000_000,
  exp: 1_700_000_300,
};

type Row = {
  purpose: string;
  target: string;
  actor: string;
  exp: number;
  state: "processing" | "consumed";
  token: string;
  updated: number;
};

/** Mimics the ledger's SQL statements in memory, atomically, to test the store's logic without a database. */
class FakeAtomicSql {
  readonly rows = new Map<string, Row>();
  schemas = 0;
  private readonly schemaReady: boolean;
  constructor(schemaReady = true) {
    this.schemaReady = schemaReady;
  }

  unsafe<T = unknown>(query: string, values: unknown[] = []): PromiseLike<T> {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.startsWith("SELECT to_regclass")) {
      this.schemas += 1;
      return Promise.resolve([{ ready: this.schemaReady }] as T);
    }
    if (normalized.startsWith("INSERT INTO vultr_broker_approval_replays")) {
      const [jti, purpose, target, actor, exp, token, now, lease] = values as [
        string,
        string,
        string,
        string,
        number,
        string,
        number,
        number,
      ];
      const old = this.rows.get(jti);
      const matches = old && old.purpose === purpose && old.target === target && old.actor === actor && old.exp === exp;
      if (!old || (matches && old.state === "processing" && old.exp > now && old.updated <= now - lease)) {
        this.rows.set(jti, { purpose, target, actor, exp, state: "processing", token, updated: now });
        return Promise.resolve([{ claim_token: token }] as T);
      }
      return Promise.resolve([] as T);
    }
    if (normalized.startsWith("UPDATE vultr_broker_approval_replays")) {
      const [jti, token] = values as [string, string];
      const row = this.rows.get(jti);
      if (row?.state === "processing" && row.token === token) {
        row.state = "consumed";
        return Promise.resolve([{ jti }] as T);
      }
      return Promise.resolve([] as T);
    }
    if (normalized.startsWith("DELETE FROM vultr_broker_approval_replays")) {
      if (normalized.includes("expires_at <")) {
        const [now] = values as [number];
        const expired = [...this.rows.entries()]
          .filter(([, row]) => row.exp < now - 86_400)
          .sort(([aJti, a], [bJti, b]) => a.exp - b.exp || aJti.localeCompare(bJti))
          .slice(0, 1000);
        for (const [jti] of expired) this.rows.delete(jti);
        return Promise.resolve([] as T);
      }
      const [jti, token] = values as [string, string];
      const row = this.rows.get(jti);
      if (row?.state === "processing" && row.token === token) {
        this.rows.delete(jti);
        return Promise.resolve([{ jti }] as T);
      }
      return Promise.resolve([] as T);
    }
    throw new Error(`unexpected SQL: ${normalized}`);
  }
}

describe("durable approval replay store", () => {
  it("has no missing-URL fallback and rejects a missing schema", async () => {
    assert.throws(() => requireReplayDatabaseUrl(undefined), /durable approval replay/);
    assert.equal(requireReplayDatabaseUrl("postgres://broker@db/replay"), "postgres://broker@db/replay");
    const store = new PostgresApprovalReplayStore(new FakeAtomicSql(false));
    await assert.rejects(store.initialize(), /schema is missing or invalid/);
  });

  it("uses a primary-key claim with conditional stale-processing recovery", () => {
    assert.ok(APPROVAL_REPLAY_SCHEMA_CHECK_SQL.includes("PRIMARY KEY (jti)"));
    assert.ok(APPROVAL_REPLAY_SCHEMA_CHECK_SQL.includes("information_schema.columns"));
    assert.ok(APPROVAL_REPLAY_CLAIM_SQL.includes("ON CONFLICT (jti) DO UPDATE"));
    assert.ok(APPROVAL_REPLAY_CLAIM_SQL.includes("state = 'processing'"));
    assert.ok(APPROVAL_REPLAY_CLAIM_SQL.includes("updated_at <="));
    assert.ok(APPROVAL_REPLAY_PRUNE_SQL.includes("INTERVAL '1 day'"));
    assert.ok(APPROVAL_REPLAY_PRUNE_SQL.includes("ORDER BY expires_at, jti"));
    assert.ok(APPROVAL_REPLAY_PRUNE_SQL.includes("LIMIT 1000"));
    assert.ok(APPROVAL_REPLAY_PRUNE_SQL.includes("FOR UPDATE SKIP LOCKED"));
  });

  it("bounds expired-row pruning per approval claim", async () => {
    const sql = new FakeAtomicSql();
    for (let i = 0; i < 1001; i += 1) {
      const jti = `${String(i).padStart(8, "0")}-1234-4234-9234-123456789012`;
      sql.rows.set(jti, {
        purpose: CLAIMS.purpose,
        target: CLAIMS.target,
        actor: CLAIMS.actor,
        exp: CLAIMS.iat - 86_401,
        state: "consumed",
        token: jti,
        updated: CLAIMS.iat - 86_401,
      });
    }

    assert.equal((await new PostgresApprovalReplayStore(sql).claim(CLAIMS, CLAIMS.iat)).ok, true);
    assert.equal(sql.rows.size, 2); // one expired row plus the newly claimed current JTI
  });

  it("blocks concurrent replicas and survives store reconstruction", async () => {
    const sql = new FakeAtomicSql();
    const firstReplica = new PostgresApprovalReplayStore(sql);
    const secondReplica = new PostgresApprovalReplayStore(sql);
    await firstReplica.initialize();
    assert.equal(sql.schemas, 1);
    const [first, second] = await Promise.all([
      firstReplica.claim(CLAIMS, CLAIMS.iat),
      secondReplica.claim(CLAIMS, CLAIMS.iat),
    ]);
    assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
    const winner = first.ok ? first : second;
    if (winner.ok) await winner.consume();
    const afterRestart = new PostgresApprovalReplayStore(sql);
    assert.equal((await afterRestart.claim(CLAIMS, CLAIMS.iat + 1)).ok, false);
  });

  it("persists a consumed long-lived JTI and rejects reusing it with the same purpose", async () => {
    const sql = new FakeAtomicSql();
    const longLived: ApprovalClaims = {
      ...CLAIMS,
      purpose: "instance-destroy",
      actor: "vultr-broker",
      exp: CLAIMS.iat + 3600,
    };
    const store = new PostgresApprovalReplayStore(sql);
    const lease = await store.claim(longLived, CLAIMS.iat);
    assert.equal(lease.ok, true);
    if (lease.ok) await lease.consume();
    assert.equal((await new PostgresApprovalReplayStore(sql).claim(longLived, CLAIMS.iat + 1)).ok, false);
    assert.equal(
      (await new PostgresApprovalReplayStore(sql).claim({ ...longLived, purpose: "instance-destroy" }, CLAIMS.iat + 1))
        .ok,
      false,
    );
  });

  it("releases a failed request and recovers only a stale processing lease", async () => {
    const sql = new FakeAtomicSql();
    const store = new PostgresApprovalReplayStore(sql, 30);
    const released = await store.claim(CLAIMS, CLAIMS.iat);
    if (released.ok) await released.release();
    assert.equal((await store.claim(CLAIMS, CLAIMS.iat + 1)).ok, true);

    const otherClaims = { ...CLAIMS, jti: "22345678-1234-4234-9234-123456789012" };
    assert.equal((await store.claim(otherClaims, CLAIMS.iat)).ok, true);
    assert.equal((await store.claim(otherClaims, CLAIMS.iat + 29)).ok, false);
    assert.equal((await store.claim(otherClaims, CLAIMS.iat + 30)).ok, true);
  });
});
