/**
 * Runs and the queue against a real PostgreSQL. The pipeline is the golden
 * fixture from packages/core, so the stored outcome can be compared with the
 * pure evaluation.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Sql } from "postgres";
import { claimJob, finishJob, reclaimExpired, renewLease } from "./queue.ts";
import { startRun } from "./runs.ts";
import { connectToSchema, createTestDb, type TestDb } from "./testing.ts";

const DEF = {
  on: { push: { branches: ["main"] } },
  jobs: {
    build: { pipeline: "C", component: "api", if: { paths: ["dispatcher/**"] } },
    docs: { pipeline: "N", if: { paths: ["docs/**"] } },
    test: { pipeline: "C", component: "api", needs: ["build"] },
    deploy: { pipeline: "N", needs: ["build", "test"] },
    always: { pipeline: "W" },
  },
};

let db: TestDb;
let sql: Sql;
const createTestDbConnection = () => connectToSchema(db.schema, 1);
before(async () => {
  db = await createTestDb();
  sql = db.sql;
  await sql`INSERT INTO projects (id, name) VALUES ('demo', 'Demo')`;
});
after(async () => db.close());

const start = (changedPaths: string[] | null = ["dispatcher/x.ts"]) =>
  startRun(sql, {
    projectId: "demo",
    event: "push",
    trigger: "push",
    ref: "refs/heads/main",
    sha: "abc",
    def: DEF,
    changedPaths,
  });

async function statuses(runId: string): Promise<Record<string, string>> {
  const rows = await sql<{ name: string; status: string }[]>`SELECT name, status FROM jobs WHERE run_id = ${runId}`;
  return Object.fromEntries(rows.map((r) => [r.name, r.status]));
}
async function runStatus(runId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`SELECT status FROM runs WHERE id = ${runId}`;
  return row?.status ?? "missing";
}
/** Claims every queued job of this run and finishes it with `result(name)`. */
async function drain(runId: string, result: (name: string) => "success" | "failed") {
  for (;;) {
    const job = await claimJob(sql, "w1", 30_000);
    if (!job) return;
    assert.equal(job.runId, runId);
    assert.equal(await finishJob(sql, job.id, "w1", result(job.name)), true);
  }
}

describe("startRun", () => {
  it("stores the definition as an object and the changed paths as an array", async () => {
    const runId = await start(["dispatcher/x.ts", "docs/한글.md"]);
    const [row] = await sql<{ t: string; paths: string[] }[]>`
      SELECT jsonb_typeof(def) AS t, changed_paths AS paths FROM runs WHERE id = ${runId}`;
    assert.equal(row?.t, "object");
    assert.deepEqual(row?.paths, ["dispatcher/x.ts", "docs/한글.md"]);
    await sql`DELETE FROM runs WHERE id = ${runId}`;
  });

  it("creates the roots: queued if their filter passes, skipped otherwise", async () => {
    const runId = await start();
    assert.deepEqual(await statuses(runId), { build: "queued", docs: "skipped", always: "queued" });
    await sql`DELETE FROM runs WHERE id = ${runId}`;
  });

  it("rejects an invalid definition without creating a run", async () => {
    const before = (await sql`SELECT count(*)::int AS n FROM runs`)[0]?.n;
    await assert.rejects(
      startRun(sql, {
        projectId: "demo",
        event: "push",
        trigger: "push",
        ref: "r",
        sha: "s",
        def: { jobs: { a: { pipeline: "C", needs: ["a"] } } },
        changedPaths: null,
      }),
      /needs itself/,
    );
    assert.equal((await sql`SELECT count(*)::int AS n FROM runs`)[0]?.n, before);
  });
});

describe("advancing a run", () => {
  it("all successes: dependents are queued in order and the run succeeds", async () => {
    const runId = await start();
    await drain(runId, () => "success");
    assert.deepEqual(await statuses(runId), {
      build: "success",
      docs: "skipped",
      test: "success",
      deploy: "success",
      always: "success",
    });
    assert.equal(await runStatus(runId), "success");
  });

  it("a failure skips its dependents transitively and fails the run", async () => {
    const runId = await start();
    await drain(runId, (name) => (name === "test" ? "failed" : "success"));
    assert.deepEqual(await statuses(runId), {
      build: "success",
      docs: "skipped",
      test: "failed",
      deploy: "skipped",
      always: "success",
    });
    assert.equal(await runStatus(runId), "failed");
  });
});

describe("claiming", () => {
  it("a job claimed in an open transaction is skipped, not waited for and taken again", async () => {
    const runId = await start();
    const other = createTestDbConnection();
    let first: Awaited<ReturnType<typeof claimJob>> = null;
    let second: Awaited<ReturnType<typeof claimJob>> = null;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const a = sql.begin(async (tx) => {
      first = await claimJob(tx, "a", 30_000);
      await held;
    });
    while (first === null) await new Promise((r) => setTimeout(r, 5));
    // While A still holds its row lock, B claims. Without SKIP LOCKED, B would
    // block on that row and take the same job once A commits.
    const b = claimJob(other, "b", 30_000).then((job) => {
      second = job;
    });
    await new Promise((r) => setTimeout(r, 200));
    release();
    await Promise.all([a, b]);
    await other.end();
    assert.ok(first && second);
    assert.notEqual((first as { id: string }).id, (second as { id: string }).id);
    await sql`DELETE FROM runs WHERE id = ${runId}`;
  });
});

describe("leases", () => {
  it("only the lease holder can finish or renew a job", async () => {
    const runId = await start(["README.md"]);
    const job = await claimJob(sql, "w1", 30_000);
    assert.equal(job?.name, "always");
    assert.equal(job?.attempt, 1);
    assert.deepEqual(job?.def, { pipeline: "W" });
    assert.equal(await finishJob(sql, job.id, "intruder", "success"), false);
    assert.equal(await renewLease(sql, job.id, "intruder", 30_000), false);
    assert.equal(await renewLease(sql, job.id, "w1", 30_000), true);
    assert.equal(await finishJob(sql, job.id, "w1", "success"), true);
    assert.equal(await finishJob(sql, job.id, "w1", "success"), false, "a second finish changes nothing");
    assert.equal(await runStatus(runId), "success");
  });

  it("an expired lease is reclaimed as unknown, its dependents skip, and the late worker is ignored", async () => {
    const runId = await start();
    const first = await claimJob(sql, "w1", 30_000);
    assert.ok(first);
    const build = first.name === "build" ? first : await claimJob(sql, "w1", 30_000);
    assert.equal(build?.name, "build");
    await sql`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${build.id}`;
    assert.equal(await reclaimExpired(sql), 1);
    assert.equal(await finishJob(sql, build.id, "w1", "success"), false, "the old holder cannot finish it");
    assert.equal(await renewLease(sql, build.id, "w1", 30_000), false);
    await drain(runId, () => "success");
    assert.deepEqual(await statuses(runId), {
      build: "unknown",
      docs: "skipped",
      test: "skipped",
      deploy: "skipped",
      always: "success",
    });
    assert.equal(await runStatus(runId), "failed");
  });

  it("rejects a result that is not an allowed transition from running", async () => {
    await assert.rejects(finishJob(sql, "00000000-0000-0000-0000-000000000000", "w1", "queued" as never), /allowed/);
  });
});
