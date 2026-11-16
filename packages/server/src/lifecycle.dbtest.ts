/**
 * A project's life through the API: a run refused before building when no
 * manifest uses the image, scaffolding the manifests, editing components one
 * at a time, and deleting the project with its manifests withdrawn.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MemoryRepo } from "@stardust/core/testing";
import { ensureBootstrapAdmin, listAudit, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
let db: TestDb;
let repo: MemoryRepo;
let app: ReturnType<typeof createApp>;
let admin: Record<string, string>;

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  const r = await signIn(db.sql, "admin", PASSWORD);
  if (!r.ok) throw new Error("admin");
  admin = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  repo = new MemoryRepo({ "apps/kustomization.yaml": "resources:\n  - shop/api\n  - other\n" });
  app = createApp(
    { version: "test" },
    {
      sql: db.sql,
      deployRepo: { repo },
      images: { repository: (p, c) => `registry.example.com/${p}/${c}` },
      resolveTarget: async () => ({ ref: "refs/heads/main", sha: "a".repeat(40) }),
    },
  );
});
after(async () => db.close());

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: admin, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("a project's life", () => {
  it("refuses a run before building when no manifest uses the component's image", async () => {
    const put = await call("PUT", "/api/v1/projects/shop", {
      githubRepo: "acme/shop",
      components: [{ name: "api", pipeline: "C", deployDir: "apps/shop/api" }],
    });
    assert.equal(put.status, 200);
    const run = await call("POST", "/api/v1/projects/shop/runs", {});
    assert.equal(run.status, 409);
    const body = (await run.json()) as { error: string; components: string[] };
    assert.deepEqual(body.components, ["api"]);
    assert.match(body.error, /api \(apps\/shop\/api\): no manifest there uses the component's image/);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM runs`)[0]?.n, 0, "nothing was started");
  });

  it("scaffolds the manifests into an empty directory, once; then the run starts", async () => {
    assert.equal((await call("POST", "/api/v1/projects/shop/components/api/scaffold", {})).status, 400);
    const made = await call("POST", "/api/v1/projects/shop/components/api/scaffold", { namespace: "shop", port: 8080 });
    assert.equal(made.status, 201);
    const files = repo.files();
    assert.ok(files["apps/shop/api/deployment.yaml"]?.includes("image: registry.example.com/shop/api:pending"));
    assert.ok(files["apps/shop/api/service.yaml"]);
    assert.equal(
      (await call("POST", "/api/v1/projects/shop/components/api/scaffold", { namespace: "shop" })).status,
      409,
    );
    assert.equal((await call("POST", "/api/v1/projects/shop/runs", {})).status, 201);
  });

  it("adds, changes and removes one component without touching the others", async () => {
    const added = await call("PUT", "/api/v1/projects/shop/components/web", {
      pipeline: "N",
      port: 3000,
      deployDir: "apps/shop/web",
    });
    assert.equal(added.status, 200);
    const names = ((await added.json()) as { components: Array<{ name: string }> }).components.map((c) => c.name);
    assert.deepEqual(names, ["api", "web"]);
    assert.equal(
      (await call("PUT", "/api/v1/projects/shop/components/web", { pipeline: "X", deployDir: "x" })).status,
      400,
    );
    assert.equal((await call("DELETE", "/api/v1/projects/shop/components/web")).status, 200);
    assert.equal((await call("DELETE", "/api/v1/projects/shop/components/web")).status, 404);
    const actions = (await listAudit(db.sql, { action: "project.component" })).events.map((e) => e.action).sort();
    assert.deepEqual(actions, ["project.component.create", "project.component.delete", "project.component.scaffold"]);
  });

  it("deletes a project only when its id is repeated, withdrawing its manifests in one commit", async () => {
    assert.equal((await call("DELETE", "/api/v1/projects/shop", { withdraw: true })).status, 400);
    const before = repo.commitCount();
    const res = await call("DELETE", "/api/v1/projects/shop", { confirm: "shop", withdraw: true });
    assert.equal(res.status, 200);
    assert.equal(repo.commitCount(), before + 1);
    const files = repo.files();
    assert.equal(Object.keys(files).filter((f) => f.startsWith("apps/shop/")).length, 0);
    assert.equal(files["apps/kustomization.yaml"], "resources:\n  - other\n", "the parent no longer lists it");
    assert.equal((await call("GET", "/api/v1/projects/shop")).status, 404);
    assert.equal((await db.sql`SELECT count(*)::int AS n FROM runs WHERE project_id = 'shop'`)[0]?.n, 0);
    const [event] = (await listAudit(db.sql, { action: "project.delete" })).events;
    assert.equal(event?.detail.withdrawn, true);
    assert.ok((await listAudit(db.sql, { projectId: "shop" })).events.length > 3, "its history stays in the audit log");
  });
});
