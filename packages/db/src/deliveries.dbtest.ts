import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cancelJob, listDeliveries } from "./deliveries.ts";
import { claimJob, finishJob, renewLease } from "./queue.ts";
import { startRun } from "./runs.ts";
import { connectToSchema, createTestDb, type TestDb } from "./testing.ts";

let db: TestDb;
before(async () => {
  db = await createTestDb();
  await db.sql`INSERT INTO projects (id, name) VALUES ('demo', 'Demo'), ('solo', 'Solo')`;
});
after(async () => db.close());

const start = (projectId: string, def: unknown, sha = "a".repeat(40), event = "workflow_dispatch") =>
  startRun(db.sql, { projectId, event, trigger: "manual", ref: "refs/heads/main", sha, def, changedPaths: null });

/** Runs every queued job to `result`, with `detail`. */
async function drain(result: "success" | "failed", detail: Record<string, unknown> = {}) {
  for (;;) {
    const job = await claimJob(db.sql, "w", 30_000);
    if (!job) return;
    assert.ok(await finishJob(db.sql, job.id, "w", result, detail));
  }
}

describe("deliveries", () => {
  it("are a component's successful builds with a digest, newest first, pull requests left out", async () => {
    const def = { on: { workflow_dispatch: {} }, jobs: { api: { pipeline: "C", component: "api" } } };
    await start("demo", def, "1".repeat(40));
    await drain("success", { digest: "sha256:one", deployCommit: "d1" });
    await start("demo", def, "2".repeat(40));
    await drain("failed", { reason: "broken" });
    await start("demo", def, "3".repeat(40), "pull_request");
    await drain("success", { digest: "sha256:pr" });
    await start("demo", def, "4".repeat(40));
    await drain("success", { digest: "sha256:four", deployCommit: "d4" });

    const list = await listDeliveries(db.sql, "demo", "api", false);
    assert.deepEqual(
      list.map((d) => [d.sha.slice(0, 1), d.digest, d.deployCommit]),
      [
        ["4", "sha256:four", "d4"],
        ["1", "sha256:one", "d1"],
      ],
    );
    assert.deepEqual(await listDeliveries(db.sql, "demo", "web", false), [], "another component's are not");
  });

  it("in a one-component project include jobs that name no component", async () => {
    await start("solo", { on: { workflow_dispatch: {} }, jobs: { build: { pipeline: "C" } } });
    await drain("success", { digest: "sha256:solo" });
    assert.equal((await listDeliveries(db.sql, "solo", "site", true))[0]?.digest, "sha256:solo");
    assert.deepEqual(await listDeliveries(db.sql, "solo", "site", false), []);
  });
});

describe("cancelling a job", () => {
  const def = { on: { workflow_dispatch: {} }, jobs: { a: { pipeline: "C" }, b: { pipeline: "C", needs: ["a"] } } };

  it("cancels a running job: its worker can no longer renew or finish it, and the run ends", async () => {
    const runId = await start("demo", def);
    const job = await claimJob(db.sql, "w", 30_000);
    assert.equal(job?.name, "a");
    assert.equal(await cancelJob(db.sql, runId, "a"), true);
    assert.equal(await renewLease(db.sql, job?.id ?? "", "w", 30_000), false, "the worker sees the lease lost");
    assert.equal(await finishJob(db.sql, job?.id ?? "", "w", "success"), false, "and its result is refused");
    const rows = await db.sql`SELECT name, status FROM jobs WHERE run_id = ${runId} ORDER BY name`;
    assert.deepEqual(
      rows.map((r) => [r.name, r.status]),
      [
        ["a", "cancelled"],
        ["b", "skipped"],
      ],
    );
    const [run] = await db.sql`SELECT status FROM runs WHERE id = ${runId}`;
    assert.notEqual(run?.status, "running");
    assert.equal(await cancelJob(db.sql, runId, "a"), false, "a finished job cannot be cancelled");
  });
});

describe("claiming with a limit", () => {
  it("never runs more than maxRunning jobs at once, however many workers claim together", async () => {
    await db.sql`DELETE FROM jobs WHERE status IN ('queued', 'running')`;
    const def = {
      on: { workflow_dispatch: {} },
      jobs: Object.fromEntries(["j1", "j2", "j3", "j4", "j5"].map((n) => [n, { pipeline: "C" }])),
    };
    await start("demo", def);
    const workers = Array.from({ length: 5 }, () => connectToSchema(db.schema, 1));
    try {
      const claimed = await Promise.all(workers.map((sql, i) => claimJob(sql, `w${i}`, 30_000, 2)));
      assert.equal(claimed.filter(Boolean).length, 2);
      const [running] = await db.sql`SELECT count(*)::int AS n FROM jobs WHERE status = 'running'`;
      assert.equal(running?.n, 2);
      assert.ok(await claimJob(db.sql, "w9", 30_000), "without a limit, the next one is claimed");
    } finally {
      await Promise.all(workers.map((sql) => sql.end()));
    }
  });
});
