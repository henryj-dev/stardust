import assert from "node:assert/strict";
import { it } from "node:test";
import { parse, parseAllDocuments } from "yaml";
import { restrictedProblems } from "./pod-security.ts";
import { scaffoldComponent } from "./scaffold.ts";
import {
  readSecretMounts,
  SECRET_FILE_MODE,
  secretKeysOf,
  secretSetDocument,
  secretSetOf,
  secretValuesOf,
  setSecretMounts,
} from "./secret-files.ts";
import { setWorkloadSettings } from "./workload.ts";

const deployment = () =>
  scaffoldComponent({
    project: "demo",
    component: "server",
    namespace: "demo",
    imageRepository: "registry.example.com/demo/server",
  }).get("deployment.yaml") ?? "";
const withGroup = () => setWorkloadSettings(deployment(), { component: "server", change: { fsGroup: 1000 } }).text;

it("keeps bytes as bytes under data, and reads the key names without the values", () => {
  const kek = Buffer.from([0, 255, 1, 254, 0x80, 0x0a]);
  const text = secretSetDocument({ component: "server", namespace: "demo", name: "kek", data: { key: kek } });
  const doc = parse(text);
  assert.equal(doc.metadata.name, "server-files-kek");
  assert.equal(doc.stringData, undefined, "never stringData: binary is not text");
  assert.deepEqual(secretKeysOf(text), ["key"]);
  assert.ok(secretValuesOf(text).key?.equals(kek));
  assert.equal(secretSetOf("deploy/demo/server/secret-files-kek.secret.enc.yaml"), "kek");
  assert.equal(secretSetOf("deploy/demo/server/env.secret.enc.yaml"), null);
});

it("mounts a set read-only at /run/secrets/<set>, mode 0440, never as env, and meets restricted", () => {
  const out = setSecretMounts(withGroup(), { component: "server", sets: ["kek"] });
  assert.equal(out.changed, true);
  const pod = parseAllDocuments(out.text)[0]?.toJS().spec.template.spec;
  assert.deepEqual(pod.volumes, [
    { name: "stardust-secret-kek", secret: { secretName: "server-files-kek", defaultMode: SECRET_FILE_MODE } },
  ]);
  assert.equal(SECRET_FILE_MODE, 0o440);
  assert.deepEqual(pod.containers[0].volumeMounts, [
    { name: "stardust-secret-kek", mountPath: "/run/secrets/kek", readOnly: true },
  ]);
  assert.ok(
    !JSON.stringify(pod.containers[0].envFrom).includes("server-files-kek"),
    "the set is not read as variables",
  );
  assert.deepEqual(restrictedProblems(out.text), []);
  assert.deepEqual(readSecretMounts(out.text, "server"), ["kek"]);
  assert.equal(setSecretMounts(out.text, { component: "server", sets: ["kek"] }).changed, false);
  const none = setSecretMounts(out.text, { component: "server", sets: [] });
  assert.equal(parseAllDocuments(none.text)[0]?.toJS().spec.template.spec.volumes, undefined);
});

it("refuses a pod without an fsGroup, and a path another volume holds", () => {
  assert.throws(() => setSecretMounts(deployment(), { component: "server", sets: ["kek"] }), /no fsGroup/);
  const taken = setWorkloadSettings(withGroup(), { component: "server", change: { writablePaths: ["/run/secrets"] } });
  assert.throws(() => setSecretMounts(taken.text, { component: "server", sets: ["kek"] }), /overlaps \/run\/secrets/);
});
