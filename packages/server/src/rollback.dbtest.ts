/**
 * Rolling a component back and cancelling a job, through the API: who may,
 * what lands in the deploy repository, and what the audit log says.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MemoryRepo } from "@stardust/core/testing";
import {
  claimJob,
  createUser,
  ensureBootstrapAdmin,
  finishJob,
  listAudit,
  putProject,
  setProjectRole,
  signIn,
  startRun,
} from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const DIR = "deploy/demo/api";
const SHA = (c: string) => c.repeat(40);
const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;
const DEF = { on: { workflow_dispatch: {} }, jobs: { api: { pipeline: "C", component: "api" } } };

let db: TestDb;
let repo: MemoryRepo;
let app: ReturnType<typeof createApp>;
const auth: Record<string, Record<string, string>> = {};
const as = (who: string) => auth[who] ?? {};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "viewer", password: PASSWORD });
  await putProject(db.sql, {
    id: "demo",
    name: "Demo",
    githubRepo: "acme/demo",
    pipelineDef: null,
    components: [{ name: "api", pipeline: "C", deployDir: DIR }],
    metadata: {},
  });
  const [viewer] = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE username = 'viewer'`;
  await setProjectRole(db.sql, "demo", viewer?.id ?? "", "viewer");
  for (const who of ["admin", "viewer"]) {
    const r = await signIn(db.sql, who, PASSWORD);
    if (!r.ok) throw new Error(who);
    auth[who] = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  }
  repo = new MemoryRepo({
    [`${DIR}/deployment.yaml`]: `image: registry.example.com/demo/api:3333333@${DIGEST("c")}\n`,
  });
  app = createApp(
    { version: "test" },
    { sql: db.sql, deployRepo: { repo }, resolveTarget: async () => ({ ref: "refs/heads/main", sha: SHA("a") }) },
  );
});
after(async () => db.close());

/** One finished delivery of `sha` with `digest`. */
async function deliver(sha: string, digest: string) {
  await startRun(db.sql, {
    projectId: "demo",
    event: "workflow_dispatch",
    trigger: "manual",
    ref: "refs/heads/main",
    sha,
    def: DEF,
    changedPaths: null,
  });
  const job = await claimJob(db.sql, "w", 30_000);
  assert.ok(job && (await finishJob(db.sql, job.id, "w", "success", { digest, deployCommit: "x" })));
  return job.id;
}

const rollback = (who: string, body: unknown = {}) =>
  app.request("/api/v1/projects/demo/components/api/rollback", {
    method: "POST",
    headers: as(who),
    body: JSON.stringify(body),
  });
const image = () => repo.files()[`${DIR}/deployment.yaml`];

describe("rollback", () => {
  it("with one delivery there is nothing to roll back to", async () => {
    await deliver(SHA("1"), DIGEST("a"));
    const res = await rollback("admin");
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "nothing to roll back to" });
  });

  it("points the component back at the previous delivery's image, in one commit, and audits it", async () => {
    const second = await deliver(SHA("2"), DIGEST("b"));
    const third = await deliver(SHA("3"), DIGEST("c"));
    const res = await rollback("admin");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "committed");
    assert.equal(body.sha, SHA("2"));
    assert.equal(body.job, second);
    assert.equal(image(), `image: registry.example.com/demo/api:2222222@${DIGEST("b")}\n`);
    const { events } = await listAudit(db.sql, { action: "project.rollback" });
    assert.equal(events[0]?.target, "api");
    assert.equal(events[0]?.detail.toJob, second);
    assert.notEqual(second, third);
  });

  it("goes to the delivery a job names, and refuses a job that is not one of them", async () => {
    const [first] = await db.sql<{ id: string }[]>`
      SELECT j.id FROM jobs j JOIN runs r ON r.id = j.run_id WHERE r.sha = ${SHA("1")}`;
    const res = await rollback("admin", { job: first?.id });
    assert.equal(res.status, 200);
    assert.equal(image(), `image: registry.example.com/demo/api:1111111@${DIGEST("a")}\n`);
    const again = await rollback("admin", { job: first?.id });
    assert.equal(((await again.json()) as { status: string }).status, "up-to-date");
    const wrong = await rollback("admin", { job: "00000000-0000-4000-8000-000000000000" });
    assert.equal(wrong.status, 409);
    assert.equal((await rollback("admin", { job: 7 })).status, 400);
  });

  it("is for those who may change the project; viewers may list the deliveries", async () => {
    assert.equal((await rollback("viewer")).status, 403);
    const list = await app.request("/api/v1/projects/demo/components/api/deliveries", { headers: as("viewer") });
    assert.equal(list.status, 200);
    const { deliveries } = (await list.json()) as { deliveries: Array<{ sha: string }> };
    assert.deepEqual(
      deliveries.map((d) => d.sha[0]),
      ["3", "2", "1"],
    );
    assert.equal(
      (await app.request("/api/v1/projects/demo/components/nope/deliveries", { headers: as("viewer") })).status,
      404,
    );
  });
});

describe("cancelling", () => {
  it("cancels a queued job once, for those who may change the project, and audits it", async () => {
    const res = await app.request("/api/v1/projects/demo/runs", { method: "POST", headers: as("admin"), body: "{}" });
    const { runId } = (await res.json()) as { runId: string };
    const url = `/api/v1/projects/demo/runs/${runId}/jobs/api/cancel`;
    assert.equal((await app.request(url, { method: "POST", headers: as("viewer") })).status, 403);
    assert.equal((await app.request(url, { method: "POST", headers: as("admin") })).status, 200);
    assert.equal((await app.request(url, { method: "POST", headers: as("admin") })).status, 409);
    assert.equal(
      (
        await app.request(`/api/v1/projects/demo/runs/${runId}/jobs/nope/cancel`, {
          method: "POST",
          headers: as("admin"),
        })
      ).status,
      404,
    );
    const { events } = await listAudit(db.sql, { action: "run.job.cancel" });
    assert.equal(events[0]?.target, `${runId}/api`);
  });
});
