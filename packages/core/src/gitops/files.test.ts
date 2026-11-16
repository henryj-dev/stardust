import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { checkFileMounts, FILES_VOLUME, readFileMounts, setFileMounts } from "./files.ts";
import { scaffoldComponent } from "./scaffold.ts";

const deployment = (
  scaffoldComponent({
    project: "pico",
    component: "push",
    namespace: "pico",
    imageRepository: "registry.example.com/pico/push",
    port: 8788,
  }).get("deployment.yaml") ?? ""
).replace("  replicas: 1", "  # one is enough: it holds no state\n  replicas: 1");

type Spec = {
  volumes?: Array<{ name: string; secret?: { secretName: string; items: Array<{ key: string; path: string }> } }>;
  containers: Array<{ name: string; volumeMounts?: Array<Record<string, unknown>> }>;
};
const specOf = (text: string) => (parse(text) as { spec: { template: { spec: Spec } } }).spec.template.spec;

const MOUNTS = [
  { key: "PUSH_TOML", path: "/etc/pico/push.toml" },
  { key: "APNS_KEY", path: "/etc/pico/secrets/AuthKey.p8" },
];

describe("files from the env Secret", () => {
  it("mounts each key on its own path, from a volume holding only those keys", () => {
    const out = setFileMounts(deployment, { component: "push", secretName: "push-env-secret", mounts: MOUNTS });
    assert.equal(out.changed, true);
    assert.equal(out.workloads, 1);
    const spec = specOf(out.text);
    assert.deepEqual(spec.volumes, [
      {
        name: FILES_VOLUME,
        secret: {
          secretName: "push-env-secret",
          items: [
            { key: "APNS_KEY", path: "APNS_KEY" },
            { key: "PUSH_TOML", path: "PUSH_TOML" },
          ],
        },
      },
    ]);
    assert.deepEqual(spec.containers[0]?.volumeMounts, [
      { name: FILES_VOLUME, mountPath: "/etc/pico/push.toml", subPath: "PUSH_TOML", readOnly: true },
      { name: FILES_VOLUME, mountPath: "/etc/pico/secrets/AuthKey.p8", subPath: "APNS_KEY", readOnly: true },
    ]);
    assert.match(out.text, /# one is enough: it holds no state/, "comments stay");
    assert.deepEqual(readFileMounts(out.text, "push"), MOUNTS);
  });

  it("replaces what it mounted before, keeps the workload's own volumes, and changes nothing twice", () => {
    const own = deployment.replace(
      "          securityContext:\n            allowPrivilegeEscalation",
      "          volumeMounts:\n            - name: tmp\n              mountPath: /tmp\n          securityContext:\n            allowPrivilegeEscalation",
    );
    const withTmp = own.replace(
      "      containers:",
      "      volumes:\n        - name: tmp\n          emptyDir: {}\n      containers:",
    );
    const first = setFileMounts(withTmp, { component: "push", secretName: "push-env-secret", mounts: MOUNTS });
    const second = setFileMounts(first.text, {
      component: "push",
      secretName: "push-env-secret",
      mounts: [MOUNTS[0] as (typeof MOUNTS)[number]],
    });
    const spec = specOf(second.text);
    assert.deepEqual(
      spec.volumes?.map((v) => v.name),
      ["tmp", FILES_VOLUME],
    );
    assert.deepEqual(spec.volumes?.[1]?.secret?.items, [{ key: "PUSH_TOML", path: "PUSH_TOML" }]);
    assert.deepEqual(
      spec.containers[0]?.volumeMounts?.map((m) => m.mountPath),
      ["/tmp", "/etc/pico/push.toml"],
    );
    const again = setFileMounts(second.text, {
      component: "push",
      secretName: "push-env-secret",
      mounts: [MOUNTS[0] as (typeof MOUNTS)[number]],
    });
    assert.equal(again.changed, false);
    assert.equal(again.text, second.text);

    const removed = setFileMounts(second.text, { component: "push", secretName: "push-env-secret", mounts: [] });
    const left = specOf(removed.text);
    assert.deepEqual(
      left.volumes?.map((v) => v.name),
      ["tmp"],
    );
    assert.deepEqual(
      left.containers[0]?.volumeMounts?.map((m) => m.mountPath),
      ["/tmp"],
    );
  });

  it("removes the lists it added when nothing is mounted any more", () => {
    const on = setFileMounts(deployment, { component: "push", secretName: "push-env-secret", mounts: MOUNTS });
    const off = setFileMounts(on.text, { component: "push", secretName: "push-env-secret", mounts: [] });
    const spec = specOf(off.text);
    assert.equal(spec.volumes, undefined);
    assert.equal(spec.containers[0]?.volumeMounts, undefined);
  });

  it("refuses a path another volume is mounted on", () => {
    const own = deployment.replace(
      "          securityContext:\n            allowPrivilegeEscalation",
      "          volumeMounts:\n            - name: config\n              mountPath: /etc/pico/push.toml\n          securityContext:\n            allowPrivilegeEscalation",
    );
    assert.throws(
      () => setFileMounts(own, { component: "push", secretName: "push-env-secret", mounts: MOUNTS }),
      /\/etc\/pico\/push\.toml is already a mount of another volume in push/,
    );
  });

  it("leaves documents without a workload alone", () => {
    const service = "apiVersion: v1\nkind: Service\nmetadata:\n  name: push\n";
    assert.deepEqual(setFileMounts(service, { component: "push", secretName: "s", mounts: MOUNTS }), {
      text: service,
      workloads: 0,
      changed: false,
    });
  });

  it("checks keys and paths, naming the entry, never a value", () => {
    assert.deepEqual(checkFileMounts(MOUNTS), MOUNTS);
    for (const [bad, reason] of [
      [[{ key: "a-b", path: "/x" }], /mounts\.0\.key/],
      [[{ key: "A", path: "relative/x" }], /absolute/],
      [[{ key: "A", path: "/etc/../shadow" }], /without \. or \.\./],
      [[{ key: "A", path: "/etc//x" }], /empty parts/],
      [[{ key: "A", path: "/" }], /empty parts/],
      [
        [
          { key: "A", path: "/x" },
          { key: "B", path: "/x" },
        ],
        /mounted twice/,
      ],
      ["nope", /a list/],
    ] as const) {
      assert.throws(() => checkFileMounts(bad), reason);
    }
  });
});
