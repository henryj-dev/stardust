/**
 * Env secrets a component reads as files, through the API: only secrets the
 * component's env Secret has, one commit, audited by name, for maintainers.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MemoryRepo } from "@stardust/core/testing";
import { createUser, ensureBootstrapAdmin, listAudit, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { parse } from "yaml";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const DIR = "apps/pico/push";
let db: TestDb;
let repo: MemoryRepo;
let app: ReturnType<typeof createApp>;
const headers: Record<string, Record<string, string>> = {};

// The rendered env Secret as SOPS leaves it: keys in clear, values sealed.
const SEALED = `apiVersion: v1
kind: Secret
metadata:
  name: push-env-secret
  namespace: pico
stringData:
  APNS_KEY: ENC[AES256_GCM,data:aaaa,type:str]
  PUSH_TOML: ENC[AES256_GCM,data:bbbb,type:str]
sops:
  version: 3.9.0
`;

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "maint", password: PASSWORD });
  await createUser(db.sql, { username: "viewer", password: PASSWORD });
  for (const name of ["admin", "maint", "viewer"]) {
    const r = await signIn(db.sql, name, PASSWORD);
    if (!r.ok) throw new Error(name);
    headers[name] = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  }
  repo = new MemoryRepo({ [`${DIR}/env.secret.enc.yaml`]: SEALED });
  app = createApp(
    { version: "test" },
    {
      sql: db.sql,
      deployRepo: { repo },
      images: { repository: (p, c) => `registry.example.com/${p}/${c}` },
      resolveTarget: async () => ({ ref: "refs/heads/main", sha: "a".repeat(40) }),
    },
  );
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: headers.admin ?? {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal(
    (
      await call("PUT", "/api/v1/projects/pico", {
        githubRepo: "acme/pico",
        components: [{ name: "push", pipeline: "C", deployDir: DIR }],
      })
    ).status,
    200,
  );
});
after(async () => db.close());

const as = (who: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: headers[who] ?? {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const FILES = "/api/v1/projects/pico/components/push/files";
const MOUNTS = [
  { key: "PUSH_TOML", path: "/etc/pico/push.toml" },
  { key: "APNS_KEY", path: "/etc/pico/secrets/AuthKey.p8" },
];

describe("files from env secrets", () => {
  it("refuses a directory with no workload to mount into", async () => {
    const res = await as("admin", "PUT", FILES, { mounts: MOUNTS });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /no Deployment, StatefulSet or DaemonSet/);
  });

  it("mounts secrets the component reads, as one commit, and says what it mounts", async () => {
    await repo.commit(
      new Map([
        [
          `${DIR}/deployment.yaml`,
          "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: push\n  namespace: pico\nspec:\n  template:\n    spec:\n      containers:\n        - name: push\n          image: registry.example.com/pico/push:pending\n",
        ],
      ]),
      "add workload",
      await repo.headSha(),
    );
    const before = await repo.headSha();
    const res = await as("admin", "PUT", FILES, { mounts: MOUNTS });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; deployCommit: string };
    assert.equal(body.status, "committed");
    assert.notEqual(await repo.headSha(), before);
    const spec = (
      parse(repo.files()[`${DIR}/deployment.yaml`] ?? "") as {
        spec: { template: { spec: { volumes: Array<{ secret: { secretName: string } }> } } };
      }
    ).spec.template.spec;
    assert.equal(spec.volumes[0]?.secret.secretName, "push-env-secret");

    const read = await as("viewer", "GET", FILES);
    assert.equal(read.status, 404, "a viewer without a role does not see the project");
    const listed = await as("admin", "GET", FILES);
    assert.deepEqual(await listed.json(), { mounts: MOUNTS, secrets: ["APNS_KEY", "PUSH_TOML"] });

    const [event] = (await listAudit(db.sql, { action: "project.component.files" })).events;
    assert.deepEqual(event?.detail, { mounts: MOUNTS, deployCommit: body.deployCommit });
    assert.doesNotMatch(JSON.stringify(event), /ENC\[/, "no sealed value reaches the audit log");
  });

  it("commits nothing when the mounts are as they are", async () => {
    const head = await repo.headSha();
    const res = await as("admin", "PUT", FILES, { mounts: MOUNTS });
    assert.deepEqual(await res.json(), { status: "no_change", deployCommit: null, mounts: MOUNTS });
    assert.equal(await repo.headSha(), head);
  });

  it("refuses a key the component's env Secret does not have, and bad paths, changing nothing", async () => {
    const head = await repo.headSha();
    const missing = await as("admin", "PUT", FILES, { mounts: [{ key: "FCM_JSON", path: "/etc/pico/fcm.json" }] });
    assert.equal(missing.status, 400);
    assert.match(
      ((await missing.json()) as { error: string }).error,
      /FCM_JSON is not a secret push reads: set it on the env page first/,
    );
    const bad = await as("admin", "PUT", FILES, { mounts: [{ key: "APNS_KEY", path: "/etc/../shadow" }] });
    assert.equal(bad.status, 400);
    assert.equal(await repo.headSha(), head);
  });

  it("lets a maintainer change them, and not a viewer", async () => {
    const pico = "/api/v1/projects/pico/members";
    assert.equal((await as("admin", "PUT", `${pico}/maint`, { role: "maintainer" })).status, 200);
    assert.equal((await as("admin", "PUT", `${pico}/viewer`, { role: "viewer" })).status, 200);
    assert.equal((await as("viewer", "GET", FILES)).status, 200);
    assert.equal((await as("viewer", "PUT", FILES, { mounts: [] })).status, 403);
    const off = await as("maint", "PUT", FILES, { mounts: [] });
    assert.equal(off.status, 200);
    assert.deepEqual(((await (await as("maint", "GET", FILES)).json()) as { mounts: unknown[] }).mounts, []);
  });
});
