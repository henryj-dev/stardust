// The replay ledger against a real PostgreSQL, through the same postgres.js adapter the
// broker uses. Skipped unless DATABASE_URL_TEST is set.
//
// The ledger's SQL names `public.vultr_broker_approval_replays`, so each run gets its own
// throwaway database rather than a schema.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import postgres from "postgres";
import { fromPostgres, PostgresApprovalReplayStore } from "./approval-replay-store.ts";
import type { ApprovalClaims } from "./policy.ts";

const url = process.env.DATABASE_URL_TEST;

const CLAIMS: ApprovalClaims = {
  v: 1,
  purpose: "instance-destroy",
  target: "6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d",
  actor: "user-1",
  jti: "12345678-1234-4234-9234-123456789012",
  iat: 1_700_000_000,
  exp: 1_700_000_300,
};

describe("durable approval replay store on PostgreSQL", { skip: url ? false : "DATABASE_URL_TEST is not set" }, () => {
  const name = `vultr_broker_${randomBytes(6).toString("hex")}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  before(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const target = new URL(url as string);
    target.pathname = `/${name}`;
    sql = postgres(target.href, { max: 4, onnotice: () => {} });
  });

  after(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    await admin?.end();
  });

  it("refuses to initialize without the table, then accepts the migrated schema", async () => {
    await assert.rejects(new PostgresApprovalReplayStore(fromPostgres(sql)).initialize(), /schema is missing/);
    await sql.unsafe(await readFile(new URL("../migrations/001_approval_replay.sql", import.meta.url), "utf8"));
    await new PostgresApprovalReplayStore(fromPostgres(sql)).initialize();
  });

  it("lets one of two concurrent claims win, and a consumed ticket stays spent", async () => {
    const a = new PostgresApprovalReplayStore(fromPostgres(sql));
    const b = new PostgresApprovalReplayStore(fromPostgres(sql));
    const [first, second] = await Promise.all([a.claim(CLAIMS, CLAIMS.iat), b.claim(CLAIMS, CLAIMS.iat)]);
    assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
    const winner = first.ok ? first : second;
    if (winner.ok) await winner.consume();
    // Even past the processing lease, a consumed row is never reclaimed.
    assert.equal((await a.claim(CLAIMS, CLAIMS.iat + 60)).ok, false);
  });

  it("releases a failed request and recovers only a stale processing lease", async () => {
    const store = new PostgresApprovalReplayStore(fromPostgres(sql), 30);
    const claims = { ...CLAIMS, jti: "22345678-1234-4234-9234-123456789012" };
    const released = await store.claim(claims, CLAIMS.iat);
    assert.equal(released.ok, true);
    if (released.ok) await released.release();
    assert.equal((await store.claim(claims, CLAIMS.iat + 1)).ok, true);
    assert.equal((await store.claim(claims, CLAIMS.iat + 29)).ok, false);
    assert.equal((await store.claim(claims, CLAIMS.iat + 31)).ok, true);
  });
});
