import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { getProject, listRuns, type Project, putProject } from "./projects.ts";
import { claimJob, finishJob } from "./queue.ts";
import { startRun } from "./runs.ts";
import { createTestDb, type TestDb } from "./testing.ts";

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => db.close());

const project: Project = {
  id: "demo",
  name: "Demo",
  githubRepo: "acme/demo",
  pipelineDef: { on: { push: { branches: ["main"] } }, jobs: { api: { pipeline: "C", component: "api" } } },
  components: [{ name: "api", pipeline: "C", deployDir: "deploy/demo/api" }],
  metadata: { owner: "team-a" },
  webhookKind: "repo",
};

it("stores and reads a project, as objects rather than JSON strings", async () => {
  await putProject(db.sql, project);
  assert.deepEqual(await getProject(db.sql, "demo"), project);
  const [row] = await db.sql<{ t: string }[]>`SELECT jsonb_typeof(components) AS t FROM projects WHERE id = 'demo'`;
  assert.equal(row?.t, "array");
});

it("updates in place", async () => {
  await putProject(db.sql, { ...project, name: "Demo 2" });
  assert.equal((await getProject(db.sql, "demo"))?.name, "Demo 2");
});

it("rejects invalid projects before writing anything", async () => {
  const bad: Project = {
    ...project,
    id: "Bad Id",
    components: [
      { name: "api", pipeline: "C", deployDir: "../escape" },
      { name: "api", pipeline: "C", deployDir: "x" },
    ],
    pipelineDef: { jobs: { a: { pipeline: "C", needs: ["a"] } } },
  };
  await assert.rejects(putProject(db.sql, bad), (err: Error) =>
    ["id", "deployDir", "duplicate", "needs itself"].every((w) => err.message.includes(w)),
  );
  assert.equal(await getProject(db.sql, "Bad Id"), null);
});

it("checks pipeline N settings: port, build environment, and no Dockerfile of its own", async () => {
  const n = (c: Partial<Project["components"][number]>): Project => ({
    ...project,
    id: "nodeapp",
    components: [{ name: "site", pipeline: "N", deployDir: "deploy/n/site", ...c }],
  });
  await putProject(db.sql, n({ port: 3000, buildEnv: { BUILD_TARGET: "node" } }));
  assert.deepEqual((await getProject(db.sql, "nodeapp"))?.components[0]?.buildEnv, { BUILD_TARGET: "node" });
  for (const [change, word] of [
    [{ dockerfile: "Dockerfile" }, "without a Dockerfile"],
    [{ port: 0 }, "TCP port"],
    [{ buildEnv: { lower: "x" } }, "UPPER_CASE_NAME"],
    [{ buildEnv: { OK: "a\nB=c" } }, "control characters"],
  ] as const) {
    await assert.rejects(putProject(db.sql, n(change as never)), (err: Error) => err.message.includes(word), word);
  }
  await assert.rejects(
    putProject(db.sql, { ...project, components: [{ name: "api", pipeline: "C", deployDir: "d", port: 1 }] }),
    /pipeline N only/,
  );
});

it("lists runs with their jobs and the details a job left behind", async () => {
  const runId = await startRun(db.sql, {
    projectId: "demo",
    event: "push",
    trigger: "push",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    def: project.pipelineDef,
    changedPaths: null,
  });
  const job = await claimJob(db.sql, "w", 30_000);
  assert.ok(job);
  await finishJob(db.sql, job.id, "w", "success", { digest: `sha256:${"b".repeat(64)}`, buildJob: "build-1" });
  const [run] = await listRuns(db.sql, "demo");
  assert.equal(run?.id, runId);
  assert.equal(run?.status, "success");
  assert.deepEqual(run?.jobs, [
    { name: "api", status: "success", attempt: 1, detail: { digest: `sha256:${"b".repeat(64)}`, buildJob: "build-1" } },
  ]);
});
