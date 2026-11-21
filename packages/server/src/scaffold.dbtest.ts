/**
 * Scaffolding lists the new directory where the GitOps controller applies
 * from, the nearest kustomization above it, as withdrawing removes it.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MemoryRepo } from "@stardust/core/testing";
import { ensureBootstrapAdmin, signIn } from "@stardust/db";
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
  repo = new MemoryRepo({
    "clusters/one/apps/kustomization.yaml": "# what runs here\nresources:\n- namespaces.yaml\n- stardust\n",
    "clusters/one/apps/stardust/kustomization.yaml": "resources:\n- release.yaml\n",
    "clusters/one/plain/kustomization.yaml": "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n",
  });
  app = createApp(
    { version: "test" },
    {
      sql: db.sql,
      deployRepo: { repo },
      images: { repository: (p, c) => `registry.example.com/${p}/${c}` },
      resolveTarget: async () => ({ ref: "refs/heads/main", sha: "a".repeat(40) }),
    },
  );
  const put = await call("PUT", "/api/v1/projects/pico", {
    githubRepo: "acme/pico",
    components: [
      { name: "push", pipeline: "C", context: "push", deployDir: "clusters/one/apps/pico/push" },
      { name: "loose", pipeline: "C", deployDir: "elsewhere/loose" },
      { name: "flat", pipeline: "C", deployDir: "clusters/one/plain/flat" },
      { name: "server", pipeline: "C", deployDir: "clusters/one/apps/pico/server" },
    ],
  });
  assert.equal(put.status, 200);
});
after(async () => db.close());

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: admin, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const scaffold = (component: string, body: unknown) =>
  call("POST", `/api/v1/projects/pico/components/${component}/scaffold`, body);

describe("scaffolding", () => {
  it("lists the directory in the nearest kustomization above it, in the same commit, with its namespace", async () => {
    const commits = repo.commitCount();
    const made = await scaffold("push", { namespace: "pico", port: 8788, createNamespace: true });
    assert.equal(made.status, 201);
    const body = (await made.json()) as { listedIn: string | null; files: string[] };
    assert.equal(body.listedIn, "clusters/one/apps/kustomization.yaml");
    assert.equal(repo.commitCount(), commits + 1, "one commit");
    assert.equal(
      repo.files()["clusters/one/apps/kustomization.yaml"],
      "# what runs here\nresources:\n- namespaces.yaml\n- stardust\n- pico/push\n",
    );
    assert.ok(body.files.includes("clusters/one/apps/pico/push/namespace.yaml"));
  });

  it("says when no kustomization above the directory can list it", async () => {
    const loose = await scaffold("loose", { namespace: "pico" });
    assert.equal(loose.status, 201);
    assert.equal(((await loose.json()) as { listedIn: string | null }).listedIn, null);
    // One without a resources list is not added to.
    const flat = await scaffold("flat", { namespace: "pico" });
    assert.equal(((await flat.json()) as { listedIn: string | null }).listedIn, null);
    assert.equal(
      repo.files()["clusters/one/plain/kustomization.yaml"],
      "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n",
    );
  });

  it("scaffolds with the workload settings in the same commit, its account listed beside it", async () => {
    assert.equal((await scaffold("server", { namespace: "pico", workload: { runAsUser: 0 } })).status, 400);
    assert.equal(repo.files()["clusters/one/apps/pico/server/deployment.yaml"], undefined, "refused before writing");
    const commits = repo.commitCount();
    const made = await scaffold("server", {
      namespace: "pico",
      port: 8080,
      workload: { serviceAccount: true, runAsUser: 1000, runAsGroup: 1000, oneAtATime: true },
    });
    assert.equal(made.status, 201);
    assert.equal(repo.commitCount(), commits + 1, "one commit");
    const body = (await made.json()) as { files: string[] };
    assert.ok(body.files.includes("clusters/one/apps/pico/server/stardust-serviceaccount.yaml"), body.files.join());
    const files = repo.files();
    assert.match(files["clusters/one/apps/pico/server/deployment.yaml"] ?? "", /serviceAccountName: server/);
    assert.match(files["clusters/one/apps/pico/server/deployment.yaml"] ?? "", /maxSurge: 0/);
    assert.match(files["clusters/one/apps/pico/server/kustomization.yaml"] ?? "", /- stardust-serviceaccount.yaml/);
  });

  it("refuses a createNamespace that is not true or false", async () => {
    assert.equal((await scaffold("push", { namespace: "pico", createNamespace: "yes" })).status, 400);
  });

  it("withdrawing the project takes the listing back out", async () => {
    const del = await call("DELETE", "/api/v1/projects/pico", { confirm: "pico", withdraw: true });
    assert.equal(del.status, 200);
    assert.equal(
      repo.files()["clusters/one/apps/kustomization.yaml"],
      "# what runs here\nresources:\n- namespaces.yaml\n- stardust\n",
    );
    assert.equal(repo.files()["clusters/one/apps/pico/push/deployment.yaml"], undefined);
  });
});
