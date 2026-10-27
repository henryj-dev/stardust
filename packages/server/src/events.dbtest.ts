/**
 * Live run updates through PostgreSQL LISTEN/NOTIFY: a subscriber gets a
 * snapshot, then a delta whenever one of its project's runs or jobs changes,
 * heartbeats while nothing happens, and nothing about other projects.
 */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { claimJob, ensureBootstrapAdmin, finishJob, putProject, type RunView, signIn, startRun } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";
import { RunEvents } from "./events.ts";

let ADMIN = "";
let db: TestDb;
let events: RunEvents;
let app: ReturnType<typeof createApp>;

const project = (id: string) => ({
  id,
  name: id,
  githubRepo: "acme/demo",
  pipelineDef: { on: { workflow_dispatch: {} }, jobs: { api: { pipeline: "N" as const } } },
  components: [],
  metadata: {},
  webhookKind: "repo" as const,
});

before(async () => {
  db = await createTestDb();
  events = new RunEvents(db.sql, 20);
  await events.start();
  app = createApp(
    { version: "test" },
    {
      sql: db.sql,
      webhookSecret: "s",
      compare: async () => ({ files: null }),
      events,
      heartbeatMs: 150,
    },
  );
  await putProject(db.sql, project("demo"));
  await putProject(db.sql, project("other"));
  await ensureBootstrapAdmin(db.sql, "admin", "correct horse battery");
  const session = await signIn(db.sql, "admin", "correct horse battery");
  if (!session.ok) throw new Error("cannot sign in");
  ADMIN = session.token;
});
after(async () => {
  await events.stop();
  await db.close();
});

/** Reads server-sent events from a response until `until` returns true. */
async function readEvents(
  res: Response,
  until: (events: Array<{ event: string; data: string }>, raw: string) => boolean,
) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let raw = "";
  const parsed: Array<{ event: string; data: string }> = [];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value);
    parsed.length = 0;
    for (const block of raw.split("\n\n")) {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) parsed.push({ event, data });
    }
    if (until(parsed, raw)) break;
  }
  await reader.cancel();
  return { parsed, raw };
}
/** Finishes every queued job — the queue is shared with the other project. */
async function finishAll() {
  for (let job = await claimJob(db.sql, "w", 30_000); job; job = await claimJob(db.sql, "w", 30_000)) {
    await finishJob(db.sql, job.id, "w", "success");
  }
}
const start = (projectId: string) =>
  startRun(db.sql, {
    projectId,
    event: "workflow_dispatch",
    trigger: "manual",
    ref: "refs/heads/main",
    sha: "c".repeat(40),
    def: project(projectId).pipelineDef,
    changedPaths: null,
  });

it("requires the admin token", async () => {
  assert.equal((await app.request("/api/v1/projects/demo/events")).status, 401);
});

it("sends a snapshot, then deltas for this project's runs as they change, with heartbeats", async () => {
  // Another project with its own subscriber, so its notifications get past the
  // listener's first filter and only the per-project fan-out keeps them apart.
  const otherSeen: string[] = [];
  const off = events.subscribe("other", (run) => otherSeen.push(run.id));
  const res = await app.request("/api/v1/projects/demo/events", { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(res.headers.get("content-type")?.startsWith("text/event-stream"), true);

  let runId = "";
  let finished = false;
  const { parsed, raw } = await readEvents(res, (evs, text) => {
    if (evs[0]?.event === "runs-snapshot" && runId === "") {
      runId = "pending";
      // Changes in another project must not reach this stream.
      void start("other").then(() => start("demo").then((id) => (runId = id)));
    }
    const done = evs.some((e) => e.event === "runs-delta" && (JSON.parse(e.data) as RunView).status === "success");
    if (!finished && runId.length > 10 && evs.some((e) => e.event === "runs-delta")) {
      finished = true;
      void finishAll();
    }
    return done && text.includes(": heartbeat");
  });

  assert.equal(parsed[0]?.event, "runs-snapshot");
  assert.deepEqual(JSON.parse(parsed[0]?.data ?? "null"), []);
  const deltas = parsed.filter((e) => e.event === "runs-delta").map((e) => JSON.parse(e.data) as RunView);
  assert.ok(deltas.length >= 2, `expected deltas for start and finish, got ${deltas.length}`);
  assert.ok(
    deltas.every((d) => d.id === runId),
    "a delta for another project's run leaked in",
  );
  assert.equal(deltas.at(-1)?.status, "success");
  assert.equal(deltas.at(-1)?.jobs[0]?.status, "success");
  assert.ok(raw.includes(": heartbeat"), "no heartbeat");
  assert.ok(otherSeen.length > 0, "the other project's subscriber got nothing: the isolation check would be vacuous");
  assert.ok(!otherSeen.includes(runId), "demo's run reached the other project's subscriber");
  off();
});
