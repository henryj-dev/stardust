/**
 * A component's cluster access through the API: a sealed registry pull
 * Secret its workloads name, and a RoleBinding for the dashboard, scaffolded
 * with it or turned on later, resealed together when the login changes.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MemoryRepo } from "@stardust/core/testing";
import { createUser, ensureBootstrapAdmin, listAudit, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { parse } from "yaml";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const APPS = "clusters/one/apps";
let db: TestDb;
let repo: MemoryRepo;
let app: ReturnType<typeof createApp>;
let password = "first";
const headers: Record<string, Record<string, string>> = {};

// A stand-in for SOPS: the sealed form says nothing of the value but decrypts back to it.
const seal = (plain: string) => `sealed: ${Buffer.from(plain).toString("base64")}\n`;
const unseal = (doc: string) => Buffer.from(String((parse(doc) as { sealed: string }).sealed), "base64").toString();
const codec = {
  decrypt: async (doc: string) => unseal(doc),
  encryptIfChanged: async (current: string | null, plain: string) =>
    current !== null && unseal(current) === plain
      ? { changed: false, document: current }
      : { changed: true, document: seal(plain) },
};

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "maint", password: PASSWORD });
  for (const name of ["admin", "maint"]) {
    const r = await signIn(db.sql, name, PASSWORD);
    if (!r.ok) throw new Error(name);
    headers[name] = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  }
  repo = new MemoryRepo({
    [`${APPS}/kustomization.yaml`]: "resources:\n- stardust\n",
    // Made by hand before stardust managed pull Secrets.
    [`${APPS}/hub/kustomization.yaml`]: "namespace: hub\nresources:\n  - deployment.yaml\n",
    [`${APPS}/hub/deployment.yaml`]:
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: hub\nspec:\n  template:\n    spec:\n      imagePullSecrets:\n        - name: zot-pull-auth\n      containers:\n        - name: hub\n          image: registry.example.com/hub/hub:abc\n",
  });
  app = createApp(
    { version: "test" },
    {
      sql: db.sql,
      deployRepo: { repo },
      images: {
        repository: (p, c) => `registry.example.com/${p}/${c}`,
        pull: { host: "registry.example.com", login: async () => ({ username: "puller", password }) },
      },
      env: { repo, codec, revisionKey: "k" },
      runtimeGrant: {
        clusterRole: "stardust-runtime-read",
        serviceAccount: "stardust-server",
        serviceAccountNamespace: "stardust",
      },
      resolveTarget: async () => ({ ref: "refs/heads/main", sha: "a".repeat(40) }),
    },
  );
  const put = await as("admin", "PUT", "/api/v1/projects/pico", {
    githubRepo: "acme/pico",
    components: [{ name: "push", pipeline: "C", context: "push", deployDir: `${APPS}/pico/push` }],
  });
  assert.equal(put.status, 200);
  const hub = await as("admin", "PUT", "/api/v1/projects/hub", {
    githubRepo: "acme/hub",
    components: [{ name: "hub", pipeline: "C", deployDir: `${APPS}/hub` }],
  });
  assert.equal(hub.status, 200);
});
after(async () => db.close());

const as = (who: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: headers[who] ?? {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const file = (path: string) => repo.files()[path];
type Pod = { imagePullSecrets?: Array<{ name: string }> };
const podOf = (path: string) => (parse(file(path) ?? "") as { spec: { template: { spec: Pod } } }).spec.template.spec;

describe("a component's cluster access", () => {
  it("scaffolds a component that can pull, be seen, and be reached, in one commit", async () => {
    const res = await as("admin", "POST", "/api/v1/projects/pico/components/push/scaffold", {
      namespace: "pico",
      port: 8788,
      createNamespace: true,
      expose: true,
      registryPull: true,
      podView: true,
    });
    assert.equal(res.status, 201);
    const dir = `${APPS}/pico/push`;
    const pull = JSON.parse(
      (parse(unseal(file(`${dir}/registry-pull.secret.enc.yaml`) ?? "")) as { stringData: Record<string, string> })
        .stringData[".dockerconfigjson"] ?? "{}",
    ) as { auths: Record<string, { username: string }> };
    assert.equal(pull.auths["registry.example.com"]?.username, "puller");
    assert.doesNotMatch(
      file(`${dir}/registry-pull.secret.enc.yaml`) ?? "",
      /first|puller/,
      "only sealed values are committed",
    );
    assert.deepEqual(podOf(`${dir}/deployment.yaml`).imagePullSecrets, [{ name: "push-registry-pull" }]);
    const binding = parse(file(`${dir}/stardust-runtime.rolebinding.yaml`) ?? "") as {
      metadata: { namespace: string };
      roleRef: { name: string };
    };
    assert.equal(binding.metadata.namespace, "pico");
    assert.equal(binding.roleRef.name, "stardust-runtime-read");
    assert.equal((parse(file(`${dir}/service.yaml`) ?? "") as { spec: { type: string } }).spec.type, "LoadBalancer");
    const listed = parse(file(`${dir}/kustomization.yaml`) ?? "") as { resources: string[] };
    assert.deepEqual(listed.resources, [
      "namespace.yaml",
      "deployment.yaml",
      "service.yaml",
      "registry-pull.secret.enc.yaml",
      "stardust-runtime.rolebinding.yaml",
    ]);

    const read = await (await as("admin", "GET", "/api/v1/projects/pico/components/push/access")).json();
    assert.deepEqual(read, {
      namespace: "pico",
      registryPull: { available: true, on: true, others: [] },
      podView: { available: true, on: true },
    });
  });

  it("adopts an existing component, showing the pull Secret it named by hand", async () => {
    const path = "/api/v1/projects/hub/components/hub/access";
    assert.deepEqual(((await (await as("admin", "GET", path)).json()) as { registryPull: unknown }).registryPull, {
      available: true,
      on: false,
      others: ["zot-pull-auth"],
    });
    const res = await as("admin", "PUT", path, { registryPull: true, podView: true });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "committed");
    assert.deepEqual(podOf(`${APPS}/hub/deployment.yaml`).imagePullSecrets, [
      { name: "zot-pull-auth" },
      { name: "hub-registry-pull" },
    ]);
    const secret = parse(unseal(file(`${APPS}/hub/registry-pull.secret.enc.yaml`) ?? "")) as {
      metadata: { namespace: string };
    };
    assert.equal(secret.metadata.namespace, "hub", "the kustomization's namespace");
    const [event] = (await listAudit(db.sql, { action: "project.component.access" })).events;
    assert.equal((event?.detail as { registryPull?: boolean } | undefined)?.registryPull, true);

    const again = await as("admin", "PUT", path, { registryPull: true, podView: true });
    assert.deepEqual(await again.json(), { status: "no_change", deployCommit: null });
  });

  it("reseals every pull Secret after the login changes, and only those", async () => {
    const head = await repo.headSha();
    const unchanged = await as("admin", "POST", "/api/v1/registry/pull/reseal");
    assert.equal(((await unchanged.json()) as { status: string }).status, "no_change");
    assert.equal(await repo.headSha(), head);

    password = "second";
    const res = await as("admin", "POST", "/api/v1/registry/pull/reseal");
    const body = (await res.json()) as { status: string; components: string[] };
    assert.equal(body.status, "committed");
    assert.deepEqual(body.components.sort(), ["hub/hub", "pico/push"]);
    for (const dir of [`${APPS}/hub`, `${APPS}/pico/push`]) {
      assert.match(unseal(file(`${dir}/registry-pull.secret.enc.yaml`) ?? ""), /cHVsbGVyOnNlY29uZA==/);
    }
  });

  it("turns access off, removing the files and their listing, and leaves the hand-made Secret", async () => {
    const res = await as("admin", "PUT", "/api/v1/projects/hub/components/hub/access", {
      registryPull: false,
      podView: false,
    });
    assert.equal(res.status, 200);
    assert.equal(file(`${APPS}/hub/registry-pull.secret.enc.yaml`), undefined);
    assert.equal(file(`${APPS}/hub/stardust-runtime.rolebinding.yaml`), undefined);
    assert.deepEqual(podOf(`${APPS}/hub/deployment.yaml`).imagePullSecrets, [{ name: "zot-pull-auth" }]);
    assert.deepEqual((parse(file(`${APPS}/hub/kustomization.yaml`) ?? "") as { resources: string[] }).resources, [
      "deployment.yaml",
    ]);
  });

  it("is for administrators, and checks what it is given", async () => {
    const path = "/api/v1/projects/hub/components/hub/access";
    assert.equal((await as("admin", "PUT", "/api/v1/projects/hub/members/maint", { role: "maintainer" })).status, 200);
    assert.equal((await as("maint", "GET", path)).status, 200);
    assert.equal((await as("maint", "PUT", path, { podView: true })).status, 403);
    assert.equal((await as("maint", "POST", "/api/v1/registry/pull/reseal")).status, 403);
    assert.equal((await as("admin", "PUT", path, { podView: "yes" })).status, 400);
    assert.equal((await as("admin", "PUT", path, { other: true })).status, 400);
    assert.equal((await as("admin", "PUT", path, {})).status, 400);
  });
});
