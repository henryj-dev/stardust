/**
 * Two worker processes drain one run of many independent jobs. Every job must
 * be executed exactly once: a duplicate claim would show up as a job finished
 * by both processes, a lost one as a job left queued.
 *
 * This is the realistic end-to-end check, but it only meets the race when two
 * claims overlap by chance — removing SKIP LOCKED does not reliably fail it.
 * The deterministic guard for claiming is "a job claimed in an open
 * transaction is skipped" in queue.dbtest.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { startRun } from "./runs.ts";
import { createTestDb, type TestDb } from "./testing.ts";

const JOBS = 200;
let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => db.close());

function worker(id: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "__fixtures__", "claimer.ts"), id], {
      env: { ...process.env, TEST_SCHEMA: db.schema },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker ${id} exited with ${code}`));
      else resolve(out.split("\n").filter(Boolean));
    });
  });
}

it(`two processes execute ${JOBS} jobs exactly once between them`, async () => {
  const jobs = Object.fromEntries(Array.from({ length: JOBS }, (_, i) => [`j${i}`, { pipeline: "N" }]));
  await db.sql`INSERT INTO projects (id, name) VALUES ('race', 'Race')`;
  const runId = await startRun(db.sql, {
    projectId: "race",
    event: "workflow_dispatch",
    trigger: "manual",
    ref: "refs/heads/main",
    sha: "abc",
    def: { on: { workflow_dispatch: {} }, jobs },
    changedPaths: null,
  });

  const [a, b] = await Promise.all([worker("a"), worker("b")]);
  const all = [...a, ...b];
  assert.equal(new Set(all).size, all.length, "a job was finished by both workers");
  assert.equal(all.length, JOBS, "a job was not executed");
  assert.ok(a.length > 0 && b.length > 0, `both workers must take part (a=${a.length}, b=${b.length})`);

  const [run] = await db.sql<{ status: string }[]>`SELECT status FROM runs WHERE id = ${runId}`;
  assert.equal(run?.status, "success");
});
