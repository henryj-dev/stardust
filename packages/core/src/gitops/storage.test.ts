import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import {
  checkStorage,
  readFsGroup,
  readStorageClaim,
  readStorageMounts,
  setStorageClaimSize,
  setStorageMounts,
  storageClaimDocument,
  storageMebibytes,
} from "./storage.ts";

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
          image: registry.example.com/pico/push:1
          volumeMounts:
            - name: stardust-files
              mountPath: /etc/pico/push.toml
              subPath: PUSH_TOML
      volumes:
        - name: stardust-files
          secret: { secretName: push-env-secret }
`;

// biome-ignore lint/suspicious/noExplicitAny: walking a parsed manifest in tests
const podOf = (text: string): any => (parse(text) as any).spec.template.spec;

describe("checkStorage", () => {
  it("takes sane volumes and refuses the rest, naming the field", () => {
    assert.deepEqual(checkStorage("push", [{ name: "data", mountPath: "/var/lib/push", size: "1Gi" }]), [
      { name: "data", mountPath: "/var/lib/push", size: "1Gi" },
    ]);
    const bad: Array<[unknown, RegExp]> = [
      [[{ name: "Data", mountPath: "/x", size: "1Gi" }], /name must be lower-case/],
      [[{ name: "d", mountPath: "relative", size: "1Gi" }], /mountPath must be an absolute path/],
      [[{ name: "d", mountPath: "/a/../b", size: "1Gi" }], /plain absolute path/],
      [[{ name: "d", mountPath: "/", size: "1Gi" }], /absolute path/],
      [[{ name: "d", mountPath: "/x", size: "1G" }], /not a size/],
      [[{ name: "d", mountPath: "/x", size: "0Gi" }], /not a size/],
      [[{ name: "d", mountPath: "/x", size: "1Gi", storageClass: "Not_A_Class" }], /StorageClass name/],
      [
        [
          { name: "d", mountPath: "/x", size: "1Gi" },
          { name: "d", mountPath: "/y", size: "1Gi" },
        ],
        /listed twice/,
      ],
      [
        [
          { name: "a", mountPath: "/x", size: "1Gi" },
          { name: "b", mountPath: "/x", size: "1Gi" },
        ],
        /mounted twice/,
      ],
    ];
    for (const [input, reason] of bad) assert.throws(() => checkStorage("push", input), reason);
    assert.throws(
      () => checkStorage("c".repeat(50), [{ name: "data-volume-long", mountPath: "/x", size: "1Gi" }]),
      /too long/,
    );
  });

  it("compares sizes across units", () => {
    assert.equal(storageMebibytes("512Mi"), 512);
    assert.equal(storageMebibytes("2Gi"), 2048);
    assert.ok(storageMebibytes("1Ti") > storageMebibytes("1000Gi"));
  });
});

describe("the claim file", () => {
  it("names the claim <component>-<name>, in the component's namespace, and its size can grow", () => {
    const text = storageClaimDocument({
      component: "push",
      namespace: "pico",
      volume: { name: "data", mountPath: "/var/lib/push", size: "1Gi", storageClass: "local-path" },
    });
    // biome-ignore lint/suspicious/noExplicitAny: a parsed manifest
    const doc = parse(text) as any;
    assert.equal(doc.kind, "PersistentVolumeClaim");
    assert.equal(doc.metadata.name, "push-data");
    assert.equal(doc.metadata.namespace, "pico");
    assert.deepEqual(doc.spec.accessModes, ["ReadWriteOnce"]);
    assert.deepEqual(readStorageClaim(text), { size: "1Gi", storageClass: "local-path" });
    assert.deepEqual(readStorageClaim(setStorageClaimSize(text, "5Gi")), { size: "5Gi", storageClass: "local-path" });
    assert.match(setStorageClaimSize(text, "5Gi"), /keeps this claim and its data/, "the comment stays");
  });
});

describe("setStorageMounts", () => {
  const mounts = [{ volume: "storage-data", claim: "push-data", mountPath: "/var/lib/push" }];

  it("mounts the claim, keeps the workload's other volumes, and rolls one pod at a time", () => {
    const out = setStorageMounts(DEPLOYMENT, { component: "push", mounts, fsGroup: 10001 });
    assert.equal(out.changed, true);
    const pod = podOf(out.text);
    assert.deepEqual(
      pod.volumes.map((v: { name: string }) => v.name),
      ["storage-data", "stardust-files"],
    );
    assert.deepEqual(pod.volumes[0].persistentVolumeClaim, { claimName: "push-data" });
    assert.ok(
      pod.containers[0].volumeMounts.some(
        (m: { name: string; mountPath: string }) => m.name === "storage-data" && m.mountPath === "/var/lib/push",
      ),
    );
    assert.equal(pod.securityContext.fsGroup, 10001);
    // biome-ignore lint/suspicious/noExplicitAny: a parsed manifest
    const strategy = (parse(out.text) as any).spec.strategy;
    assert.deepEqual(strategy, { type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } });
    assert.deepEqual(readStorageMounts(out.text, "push"), {
      managed: [{ volume: "storage-data", claim: "push-data", mountPath: "/var/lib/push" }],
      other: [],
    });
    assert.equal(readFsGroup(out.text), 10001);
    assert.equal(
      setStorageMounts(out.text, { component: "push", mounts }).changed,
      false,
      "the same again changes nothing",
    );
  });

  it("leaves a Recreate strategy as it is", () => {
    const recreate = DEPLOYMENT.replace("  replicas: 1\n", "  replicas: 1\n  strategy: { type: Recreate }\n");
    // biome-ignore lint/suspicious/noExplicitAny: a parsed manifest
    const strategy = (parse(setStorageMounts(recreate, { component: "push", mounts }).text) as any).spec.strategy;
    assert.deepEqual(strategy, { type: "Recreate" });
  });

  it("unmounting removes only stardust's volumes, and fsGroup null removes it", () => {
    const on = setStorageMounts(DEPLOYMENT, { component: "push", mounts, fsGroup: 10001 }).text;
    const off = setStorageMounts(on, { component: "push", mounts: [], fsGroup: null });
    const pod = podOf(off.text);
    assert.deepEqual(
      pod.volumes.map((v: { name: string }) => v.name),
      ["stardust-files"],
    );
    assert.equal(pod.securityContext, undefined);
  });

  it("refuses a path or a volume name another volume already has", () => {
    assert.throws(
      () =>
        setStorageMounts(DEPLOYMENT, {
          component: "push",
          mounts: [{ volume: "storage-data", claim: "push-data", mountPath: "/etc/pico/push.toml" }],
        }),
      /already a mount of another volume in push/,
    );
  });

  it("takes over a workload's own claim volume by renaming it, the claim untouched", () => {
    const own = DEPLOYMENT.replace(
      "      volumes:\n",
      "      volumes:\n        - name: db\n          persistentVolumeClaim: { claimName: push-db }\n",
    ).replace(
      "              subPath: PUSH_TOML\n",
      "              subPath: PUSH_TOML\n            - name: db\n              mountPath: /var/lib/db\n",
    );
    assert.deepEqual(readStorageMounts(own, "push").other, [
      { volume: "db", claim: "push-db", mountPath: "/var/lib/db" },
    ]);
    const out = setStorageMounts(own, {
      component: "push",
      mounts: [{ volume: "storage-db", claim: "push-db", mountPath: "/var/lib/db" }],
      rename: new Map([["db", "storage-db"]]),
    });
    const found = readStorageMounts(out.text, "push");
    assert.deepEqual(found.managed, [{ volume: "storage-db", claim: "push-db", mountPath: "/var/lib/db" }]);
    assert.deepEqual(found.other, []);
  });
});
