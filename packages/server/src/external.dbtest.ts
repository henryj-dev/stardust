/** External projects through the API: a pinned project runs its pin, and its code is not built unless allowed. */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { MemoryRepo } from "@stardust/core/testing";
import { ensureBootstrapAdmin, putProject, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const PIN = "1".repeat(40);
const DIGEST = `sha256:${"9".repeat(64)}`;
let db: TestDb;
let admin: Record<string, string>;
const asked: unknown[] = [];

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  const r = await signIn(db.sql, "admin", PASSWORD);
  if (!r.ok) throw new Error("admin");
  admin = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  await putProject(db.sql, {
    id: "counter",
    name: "Counter",
    githubRepo: "upstream/counter",
    pipelineDef: null,
    components: [
      { name: "app", pipeline: "M", image: `docker.io/upstream/counter:2.7@${DIGEST}`, deployDir: "deploy/counter" },
    ],
    metadata: { trust: "external", pin: PIN },
  });
  await putProject(db.sql, {
    id: "station",
    name: "Station",
    githubRepo: "upstream/station",
    pipelineDef: null,
    components: [{ name: "hub", pipeline: "C", deployDir: "deploy/station" }],
    metadata: { trust: "external" },
  });
});
after(async () => db.close());

function app(upstreamBuilds: string[] = []) {
  return createApp(
    { version: "t" },
    {
      sql: db.sql,
      deployRepo: {
        repo: new MemoryRepo({
          "deploy/counter/deployment.yaml": "image: registry.example.com/counter/app:old\n",
          "deploy/station/deployment.yaml": "image: registry.example.com/station/hub:old\n",
        }),
      },
      images: { repository: (p, c) => `registry.example.com/${p}/${c}` },
      upstreamBuilds,
      resolveTarget: async (_repo, target) => {
        asked.push(target);
        const sha = (target as { sha?: string }).sha ?? "2".repeat(40);
        return { ref: "refs/heads/main", sha };
      },
    },
  );
}
const run = (a: ReturnType<typeof app>, project: string, body: unknown = {}) =>
  a.request(`/api/v1/projects/${project}/runs`, { method: "POST", headers: admin, body: JSON.stringify(body) });

it("runs a pinned project's pin when nothing else is asked, and refuses another commit before queuing", async () => {
  const a = app();
  assert.equal((await run(a, "counter")).status, 201);
  assert.deepEqual(asked.at(-1), { sha: PIN });
  const other = await run(a, "counter", { branch: "main" });
  assert.equal(other.status, 409);
  assert.match(((await other.json()) as { error: string }).error, /pinned to/);
});

it("refuses to build an external project's code unless the operator allows it", async () => {
  const before = (await db.sql`SELECT count(*)::int AS n FROM runs WHERE project_id = 'station'`)[0]?.n;
  const refused = await run(app(), "station");
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /upstreamBuilds/);
  assert.equal(
    (await db.sql`SELECT count(*)::int AS n FROM runs WHERE project_id = 'station'`)[0]?.n,
    before,
    "nothing queued",
  );
  assert.equal((await run(app(["station"]), "station")).status, 201);
});
