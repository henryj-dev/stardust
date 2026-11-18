import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LeaseHandoff, type Logger } from "@stardust/core";
import { cancelJob, claimJob, reclaimExpired, startRun } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { runJob, runWorker } from "./loop.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let db: TestDb;
before(async () => {
  db = await createTestDb();
  await db.sql`INSERT INTO projects (id, name) VALUES ('w', 'W')`;
});
after(async () => db.close());

const start = (jobs: Record<string, unknown>) =>
  startRun(db.sql, {
    projectId: "w",
    event: "workflow_dispatch",
    trigger: "manual",
    ref: "refs/heads/main",
    sha: "abc",
    def: { on: { workflow_dispatch: {} }, jobs },
    changedPaths: null,
  });
const statusOf = async (runId: string, name: string) =>
  (await db.sql<{ status: string }[]>`SELECT status FROM jobs WHERE run_id = ${runId} AND name = ${name}`)[0]?.status;

it("runs jobs in dependency order until stopped", async () => {
  const runId = await start({ a: { pipeline: "N" }, b: { pipeline: "N", needs: ["a"] } });
  const seen: string[] = [];
  const stop = new AbortController();
  const done = runWorker({
    sql: db.sql,
    workerId: "w1",
    log: quiet,
    idleMs: 10,
    signal: stop.signal,
    handler: async (job) => {
      seen.push(job.name);
      if (seen.length === 2) stop.abort();
      return "success";
    },
  });
  await done;
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(await statusOf(runId, "b"), "success");
});

it("a handler that throws fails the job", async () => {
  const runId = await start({ boom: { pipeline: "N" } });
  const job = await claimJob(db.sql, "w2", 30_000);
  assert.ok(job);
  const result = await runJob(
    {
      sql: db.sql,
      workerId: "w2",
      log: quiet,
      leaseMs: 30_000,
      handler: async () => {
        throw new Error("kaboom");
      },
    },
    job,
  );
  assert.equal(result, "failed");
  assert.equal(await statusOf(runId, "boom"), "failed");
});

it("a lost lease aborts the handler and discards its result", async () => {
  const runId = await start({ slow: { pipeline: "N" } });
  const job = await claimJob(db.sql, "w3", 30_000);
  assert.ok(job);
  let aborted = false;
  const result = await runJob(
    {
      sql: db.sql,
      workerId: "w3",
      log: quiet,
      leaseMs: 150,
      handler: async (_job, signal) => {
        // Someone else takes the job over while this handler works.
        await db.sql`UPDATE jobs SET lease_owner = 'other' WHERE id = ${job.id}`;
        for (let i = 0; i < 40 && !signal.aborted; i++) await sleep(25);
        aborted = signal.aborted;
        return "success";
      },
    },
    job,
  );
  assert.equal(aborted, true, "the handler was not told the lease was lost");
  assert.equal(result, null);
  assert.equal(await statusOf(runId, "slow"), "running", "the discarded result must not be recorded");
});

it("cancelling a running job stops its handler, and the job stays cancelled", async () => {
  const runId = await start({ long: { pipeline: "C" } });
  const job = await claimJob(db.sql, "w4", 30_000);
  assert.ok(job);
  let aborted = false;
  const result = await runJob(
    {
      sql: db.sql,
      workerId: "w4",
      log: quiet,
      leaseMs: 150,
      handler: async (_job, signal) => {
        assert.equal(await cancelJob(db.sql, runId, "long"), true);
        for (let i = 0; i < 40 && !signal.aborted; i++) await sleep(25);
        aborted = signal.aborted;
        return "success";
      },
    },
    job,
  );
  assert.equal(aborted, true, "the build was not told to stop");
  assert.equal(result, null);
  assert.equal(await statusOf(runId, "long"), "cancelled");
});

it("a job queued again for another worker aborts its handler as a hand-off, not a cancellation", async () => {
  await start({ slow: { pipeline: "N" } });
  const job = await claimJob(db.sql, "w-old", 200);
  assert.ok(job);
  let reason: unknown;
  const result = runJob(
    {
      sql: db.sql,
      workerId: "w-old",
      log: quiet,
      leaseMs: 200,
      handler: (_job, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            resolve("success");
          });
        }),
    },
    job,
  );
  // The worker stalls past its lease (a pod being replaced) and the job is taken back.
  await db.sql`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${job.id}`;
  assert.equal(await reclaimExpired(db.sql), 1);
  assert.equal(await result, null, "the old worker records nothing");
  assert.ok(reason instanceof LeaseHandoff, "the Kubernetes Job is left for the next worker");
  const [row] = await db.sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${job.id}`;
  assert.equal(row?.status, "queued");
  await db.sql`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = ${job.id}`;
});
