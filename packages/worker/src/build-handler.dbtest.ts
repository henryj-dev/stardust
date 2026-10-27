/**
 * The build handler end to end inside the worker: a queued job is built by a
 * fake Kubernetes API, the in-memory deploy repository gets the digest, and
 * the job records what it did. Failures of either step fail the job.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Logger } from "@stardust/core";
import { claimJob, putProject, startRun } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import type { KubeClient } from "@stardust/plugin-builder-buildkit";
import { MemoryRepo } from "@stardust/plugin-gitops-git/testing";
import { buildHandler } from "./build-handler.ts";
import { runJob } from "./loop.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DIGEST = `sha256:${"d".repeat(64)}`;
const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const DIR = "deploy/demo/api";
let db: TestDb;

before(async () => {
  db = await createTestDb();
  await putProject(db.sql, {
    id: "demo",
    name: "Demo",
    githubRepo: "acme/demo",
    pipelineDef: { on: { workflow_dispatch: {} }, jobs: { api: { pipeline: "C", component: "api" } } },
    components: [{ name: "api", pipeline: "C", context: "api", deployDir: DIR }],
    metadata: {},
    webhookKind: "repo",
  });
});
after(async () => db.close());

function kube(final: Record<string, unknown>, log: string) {
  const created: Array<Record<string, unknown>> = [];
  const client: KubeClient = {
    async request(method, path, body) {
      if (method === "POST") {
        created.push(body as Record<string, unknown>);
        return { status: 201, body: JSON.stringify({ metadata: { name: "build-demo-1" } }) };
      }
      if (path.includes("/pods?"))
        return { status: 200, body: JSON.stringify({ items: [{ metadata: { name: "p" } }] }) };
      if (path.includes("/log")) return { status: 200, body: log };
      return { status: 200, body: JSON.stringify({ status: final }) };
    },
  };
  return { client, created };
}

async function runOnce(client: KubeClient, repo: MemoryRepo) {
  const runId = await startRun(db.sql, {
    projectId: "demo",
    event: "workflow_dispatch",
    trigger: "manual",
    ref: "refs/heads/main",
    sha: SHA,
    def: { on: { workflow_dispatch: {} }, jobs: { api: { pipeline: "C", component: "api" } } },
    changedPaths: null,
  });
  const job = await claimJob(db.sql, "w", 30_000);
  assert.ok(job);
  const handler = buildHandler({
    sql: db.sql,
    kube: client,
    namespace: "builds",
    registry: "registry.example.com",
    builder: { cloneSecret: "clone", pushSecret: "push" },
    deployRepo: repo,
    log: quiet,
    pollMs: 1,
  });
  const result = await runJob({ sql: db.sql, workerId: "w", handler, log: quiet, leaseMs: 30_000 }, job);
  const [row] = await db.sql<{ status: string; detail: Record<string, unknown> }[]>`
    SELECT status, detail FROM jobs WHERE run_id = ${runId}`;
  return { result, row, runId };
}

describe("buildHandler", () => {
  it("builds, bumps the deploy repository to the digest, and records both", async () => {
    const repo = new MemoryRepo({ [`${DIR}/deployment.yaml`]: "image: registry.example.com/demo/api:old\n" });
    const { client, created } = kube({ succeeded: 1 }, `[stardust-image-digest] ${DIGEST}\n`);
    const { result, row } = await runOnce(client, repo);
    assert.equal(result, "success");
    assert.equal(row?.status, "success");
    assert.equal(row?.detail.digest, DIGEST);
    assert.equal(row?.detail.buildJob, "build-demo-1");
    assert.equal(typeof row?.detail.deployCommit, "string");
    assert.equal(
      repo.files()[`${DIR}/deployment.yaml`],
      `image: registry.example.com/demo/api:abcdef1@sha256:${"d".repeat(64)}\n`,
    );
    const env = JSON.stringify(created[0]);
    assert.ok(env.includes('"IMAGE","value":"registry.example.com/demo/api:abcdef1"'));
    assert.ok(env.includes('"CONTEXT","value":"api"'));
  });

  it("a failed build fails the job and leaves the deploy repository alone", async () => {
    const repo = new MemoryRepo({ [`${DIR}/deployment.yaml`]: "image: registry.example.com/demo/api:old\n" });
    const { client } = kube({ failed: 1 }, "error: Dockerfile not found\n");
    const { row } = await runOnce(client, repo);
    assert.equal(row?.status, "failed");
    assert.match(String(row?.detail.logTail), /Dockerfile not found/);
    assert.equal(repo.commitCount(), 0);
  });

  it("a deploy repository without the image fails the job: built is not delivered", async () => {
    const repo = new MemoryRepo({ [`${DIR}/deployment.yaml`]: "image: registry.example.com/other/thing:old\n" });
    const { client } = kube({ succeeded: 1 }, `[stardust-image-digest] ${DIGEST}\n`);
    const { row } = await runOnce(client, repo);
    assert.equal(row?.status, "failed");
    assert.match(String(row?.detail.reason), /no manifest .* references demo\/api/);
    assert.equal(row?.detail.digest, DIGEST, "the digest that was built is still recorded");
  });
});
