/**
 * A component's persistent storage, through the API: claim files listed in the
 * kustomization, mounts in the workload, one commit each, data kept unless it is
 * deleted on purpose, and a hand-made claim taken over without being made again.
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
const STORAGE = "/api/v1/projects/pico/components/push/storage";
let db: TestDb;
let repo: MemoryRepo;
let app: ReturnType<typeof createApp>;
const headers: Record<string, Record<string, string>> = {};

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: push
  namespace: pico
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: push
          image: registry.example.com/pico/push:pending
`;
const KUSTOMIZATION =
  "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deployment.yaml\n";

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  await createUser(db.sql, { username: "viewer", password: PASSWORD });
  for (const name of ["admin", "viewer"]) {
    const r = await signIn(db.sql, name, PASSWORD);
    if (!r.ok) throw new Error(name);
    headers[name] = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  }
  repo = new MemoryRepo({ [`${DIR}/kustomization.yaml`]: KUSTOMIZATION });
  app = createApp(
    { version: "test" },
    {
      sql: db.sql,
      deployRepo: { repo },
      images: { repository: (p, c) => `registry.example.com/${p}/${c}` },
      resolveTarget: async () => ({ ref: "refs/heads/main", sha: "a".repeat(40) }),
    },
  );
  assert.equal(
    (
      await as("admin", "PUT", "/api/v1/projects/pico", {
        githubRepo: "acme/pico",
        components: [{ name: "push", pipeline: "C", deployDir: DIR }],
      })
    ).status,
    200,
  );
  assert.equal((await as("admin", "PUT", "/api/v1/projects/pico/members/viewer", { role: "viewer" })).status, 200);
});
after(async () => db.close());

const as = (who: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: headers[who] ?? {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const put = async (body: unknown) => {
  const res = await as("admin", "PUT", STORAGE, body);
  return { status: res.status, body: (await res.json()) as { status?: string; deployCommit?: string; error?: string } };
};
const read = async () =>
  (await (await as("admin", "GET", STORAGE)).json()) as {
    namespace: string | null;
    volumes: Array<{ name: string; mountPath: string; size: string | null; claim: string; claimFile: boolean }>;
    kept: Array<{ name: string; claim: string; size: string | null }>;
    other: Array<{ volume: string; claim: string; mountPath: string | null }>;
    fsGroup: number | null;
  };
const file = (name: string) => repo.files()[`${DIR}/${name}`];
// biome-ignore lint/suspicious/noExplicitAny: walking a parsed manifest in tests
const pod = (): any => (parse(file("deployment.yaml") ?? "") as any).spec.template.spec;
const listed = () => (parse(file("kustomization.yaml") ?? "") as { resources: string[] }).resources;
const DATA = { name: "data", mountPath: "/var/lib/push", size: "1Gi" };

describe("component storage", () => {
  it("refuses a directory with no workload", async () => {
    const r = await put({ volumes: [DATA] });
    assert.equal(r.status, 400);
    assert.match(r.body.error ?? "", /no Deployment, StatefulSet or DaemonSet/);
  });

  it("adds a volume: its claim file, listed, and the mount, as one commit", async () => {
    await repo.commit(new Map([[`${DIR}/deployment.yaml`, DEPLOYMENT]]), "add workload", await repo.headSha());
    const commits = repo.commitCount();
    const r = await put({ volumes: [DATA], fsGroup: 10001 });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "committed");
    assert.equal(repo.commitCount(), commits + 1, "one commit");
    // biome-ignore lint/suspicious/noExplicitAny: a parsed manifest
    const claim = parse(file("storage-data.pvc.yaml") ?? "") as any;
    assert.equal(claim.metadata.name, "push-data");
    assert.equal(claim.metadata.namespace, "pico");
    assert.ok(listed().includes("storage-data.pvc.yaml"));
    assert.deepEqual(pod().volumes, [{ name: "storage-data", persistentVolumeClaim: { claimName: "push-data" } }]);
    assert.equal(pod().securityContext.fsGroup, 10001);
    assert.deepEqual(await read(), {
      namespace: "pico",
      volumes: [{ name: "data", mountPath: "/var/lib/push", claim: "push-data", claimFile: true, size: "1Gi" }],
      kept: [],
      other: [],
      fsGroup: 10001,
    });
    const [event] = (await listAudit(db.sql, { action: "project.component.storage" })).events;
    assert.equal(event?.target, "push");
  });

  it("commits nothing for the same storage, grows a volume, and refuses to shrink it", async () => {
    const head = await repo.headSha();
    assert.equal((await put({ volumes: [DATA] })).body.status, "no_change");
    assert.equal(await repo.headSha(), head);
    assert.equal((await put({ volumes: [{ ...DATA, size: "2Gi" }] })).body.status, "committed");
    assert.equal((await read()).volumes[0]?.size, "2Gi");
    const shrink = await put({ volumes: [DATA] });
    assert.equal(shrink.status, 400);
    assert.match(shrink.body.error ?? "", /can grow, not shrink/);
  });

  it("unmounting keeps the claim and its data; only deleteData removes it", async () => {
    const off = await put({ volumes: [] });
    assert.equal(off.body.status, "committed");
    assert.equal(pod().volumes, undefined, "unmounted");
    assert.ok(file("storage-data.pvc.yaml"), "the claim file stays: the data is kept");
    assert.ok(listed().includes("storage-data.pvc.yaml"));
    assert.deepEqual((await read()).kept, [{ name: "data", claim: "push-data", size: "2Gi" }]);

    const mounted = await put({ volumes: [{ ...DATA, size: "2Gi" }], deleteData: ["data"] });
    assert.equal(mounted.status, 400, "a mounted volume's data cannot be deleted");
    const gone = await put({ volumes: [], deleteData: ["data"] });
    assert.equal(gone.body.status, "committed");
    assert.equal(file("storage-data.pvc.yaml"), undefined);
    assert.ok(!listed().includes("storage-data.pvc.yaml"));
    assert.deepEqual((await read()).kept, []);
  });

  it("finds a claim mounted by hand under stardust's names as its own, without making it again", async () => {
    // As a person would add it before the Storage page existed: the file and the mount, named the same way.
    const byHand = DEPLOYMENT.replace(
      "  replicas: 1\n",
      "  replicas: 1\n  strategy:\n    type: RollingUpdate\n    rollingUpdate: { maxSurge: 0, maxUnavailable: 1 }\n",
    ).replace(
      "          image: registry.example.com/pico/push:pending\n",
      "          image: registry.example.com/pico/push:pending\n          volumeMounts:\n            - name: storage-data\n              mountPath: /var/lib/push\n      volumes:\n        - name: storage-data\n          persistentVolumeClaim: { claimName: push-data }\n",
    );
    const claim =
      "apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: push-data\n  namespace: pico\nspec:\n  accessModes: [ReadWriteOnce]\n  resources:\n    requests: { storage: 1Gi }\n";
    await repo.commit(
      new Map([
        [`${DIR}/deployment.yaml`, byHand],
        [`${DIR}/storage-data.pvc.yaml`, claim],
        [`${DIR}/kustomization.yaml`, `${KUSTOMIZATION}  - storage-data.pvc.yaml\n`],
      ]),
      "by hand",
      await repo.headSha(),
    );
    assert.deepEqual((await read()).volumes, [
      { name: "data", mountPath: "/var/lib/push", claim: "push-data", claimFile: true, size: "1Gi" },
    ]);
    const head = await repo.headSha();
    assert.equal((await put({ volumes: [DATA] })).body.status, "no_change", "nothing is made again");
    assert.equal(await repo.headSha(), head);
  });

  it("takes over a workload's own claim volume, renaming only the pod volume", async () => {
    const own = DEPLOYMENT.replace(
      "          image: registry.example.com/pico/push:pending\n",
      "          image: registry.example.com/pico/push:pending\n          volumeMounts:\n            - name: cache\n              mountPath: /var/cache/push\n      volumes:\n        - name: cache\n          persistentVolumeClaim: { claimName: push-cache }\n",
    );
    await repo.commit(new Map([[`${DIR}/deployment.yaml`, own]]), "own volume", await repo.headSha());
    assert.deepEqual((await read()).other, [{ volume: "cache", claim: "push-cache", mountPath: "/var/cache/push" }]);
    const r = await put({ volumes: [{ name: "cache", mountPath: "/var/cache/push", size: "1Gi" }], adopt: ["cache"] });
    assert.equal(r.body.status, "committed", r.body.error ?? "");
    assert.deepEqual(pod().volumes[0], { name: "storage-cache", persistentVolumeClaim: { claimName: "push-cache" } });
    assert.equal(file("storage-cache.pvc.yaml"), undefined, "the claim lives where it was: no file is made");
    const now = await read();
    assert.deepEqual(now.other, []);
    assert.ok(now.volumes.some((v) => v.name === "cache" && v.claim === "push-cache" && !v.claimFile));
  });

  it("lets a viewer read and not change", async () => {
    assert.equal((await as("viewer", "GET", STORAGE)).status, 200);
    assert.equal((await as("viewer", "PUT", STORAGE, { volumes: [] })).status, 403);
  });

  it("refuses bad input naming the field", async () => {
    const r = await put({ volumes: [{ name: "Bad", mountPath: "/x", size: "1Gi" }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error ?? "", /name must be lower-case/);
    assert.equal((await put({ volumes: [], fsGroup: -1 })).status, 400);
  });
});
