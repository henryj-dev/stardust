import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { MASKED, mergeEnv } from "./merge.ts";
import { envRevision, renderEnv } from "./render.ts";

const sopsDoc = (keys: Record<string, string>) =>
  `apiVersion: v1\nkind: Secret\nstringData:\n${Object.keys(keys)
    .map((k) => `  ${k}: ENC[AES256_GCM,data:x,type:str]`)
    .join("\n")}\nsops:\n  version: 3.9.0\n`;

const files: Record<string, string> = {
  "deploy/env/_global/runtime.yaml": "LOG_LEVEL: info\nREGION: global\n",
  "deploy/env/_global/runtime.secret.enc.yaml": sopsDoc({ SHARED_TOKEN: "g" }),
  "deploy/env/_global/build.yaml": "NODE_ENV: production\n",
  "deploy/env/demo/_shared/runtime.yaml": "REGION: project\nPORT: 8080\n",
  "deploy/env/demo/api/runtime.yaml": "PORT: 9090\nSHARED_TOKEN: now-plain\n",
  "deploy/env/demo/api/runtime.secret.enc.yaml": sopsDoc({ DB_PASSWORD: "p" }),
  "deploy/env/demo/api/runtime.secret.PLAINTEXT.yaml": "LEAKED: must-not-be-read\n",
};
const read = async (path: string) => files[path] ?? null;
const decrypted: Record<string, Record<string, string>> = {
  "deploy/env/_global/runtime.secret.enc.yaml": { SHARED_TOKEN: "global-secret" },
  "deploy/env/demo/api/runtime.secret.enc.yaml": { DB_PASSWORD: "hunter2" },
};
const decrypt = async (doc: string) => {
  const path = Object.keys(files).find((p) => files[p] === doc) as string;
  const values = decrypted[path] as Record<string, string>;
  return `stringData:\n${Object.entries(values)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n")}\n`;
};
const byKey = (merged: Awaited<ReturnType<typeof mergeEnv>>, scope = "runtime") =>
  Object.fromEntries(merged.filter((e) => e.scope === scope).map((e) => [e.key, e]));

describe("mergeEnv", () => {
  it("cascades global → project shared → component, later layers winning", async () => {
    const env = byKey(await mergeEnv({ read, decrypt, project: "Demo", component: "api" }));
    assert.equal(env.LOG_LEVEL?.value, "info");
    assert.equal(env.REGION?.value, "project");
    assert.equal(env.PORT?.value, "9090");
    assert.equal(env.PORT?.component, "api");
    assert.equal(env.DB_PASSWORD?.value, "hunter2");
    assert.equal(env.DB_PASSWORD?.enc, true);
  });
  it("a later plain value overrides an earlier secret, and the key stops being secret", async () => {
    const env = byKey(await mergeEnv({ read, decrypt, project: "demo", component: "api" }));
    assert.deepEqual([env.SHARED_TOKEN?.value, env.SHARED_TOKEN?.enc], ["now-plain", false]);
  });
  it("masked reads list encrypted keys without decrypting", async () => {
    const env = byKey(
      await mergeEnv({
        read,
        project: "demo",
        component: "api",
        masked: true,
        decrypt: async () => assert.fail("decrypt was called"),
      }),
    );
    assert.equal(env.DB_PASSWORD?.value, MASKED);
  });
  it("keeps scopes apart and never reads plain-text secret files", async () => {
    const merged = await mergeEnv({ read, decrypt, project: "demo", component: "api" });
    assert.equal(byKey(merged, "build").NODE_ENV?.value, "production");
    assert.ok(!merged.some((e) => e.key === "LEAKED"));
  });
});

describe("renderEnv", () => {
  it("renders the runtime scope as a ConfigMap and a Secret with the predecessor's names", async () => {
    const merged = await mergeEnv({ read, decrypt, project: "demo", component: "api" });
    const out = renderEnv({ merged, component: "api", namespace: "demo", revisionKey: "k" });
    const cm = parse(out.configMapYaml) as {
      metadata: { name: string; annotations: Record<string, string> };
      data: Record<string, string>;
    };
    const secret = parse(out.secretYaml) as { metadata: { name: string }; stringData: Record<string, string> };
    assert.equal(cm.metadata.name, "api-env");
    assert.equal(secret.metadata.name, "api-env-secret");
    assert.deepEqual(cm.data, { LOG_LEVEL: "info", REGION: "project", PORT: "9090", SHARED_TOKEN: "now-plain" });
    assert.deepEqual(secret.stringData, { DB_PASSWORD: "hunter2" });
    assert.equal(cm.metadata.annotations["stardust.io/env-revision"], out.revision);
    assert.ok(!("NODE_ENV" in cm.data), "build-scope values are not runtime environment");
  });
  it("a key with a newline cannot break out of data", () => {
    const merged = [
      {
        scope: "runtime" as const,
        key: "A\nmetadata:\n  name: evil",
        value: "x",
        enc: false,
        source: "project" as const,
        component: "",
      },
    ];
    const cm = parse(renderEnv({ merged, component: "api", namespace: "demo", revisionKey: "k" }).configMapYaml) as {
      metadata: { name: string };
    };
    assert.equal(cm.metadata.name, "api-env");
  });
  it("the revision changes with any key or value and does not depend on order", () => {
    const a = envRevision({ X: "1", Y: "2" }, { S: "s" }, "k");
    assert.equal(envRevision({ Y: "2", X: "1" }, { S: "s" }, "k"), a);
    assert.notEqual(envRevision({ X: "1", Y: "3" }, { S: "s" }, "k"), a);
    assert.notEqual(envRevision({ X: "1" }, { S: "s", Y: "2" }, "k"), a, "moving a key into the Secret changes it");
    assert.notEqual(envRevision({ X: "1", Y: "2" }, { S: "s" }, "other-key"), a);
  });
  it("an operation-bound Secret has its own name and annotation", () => {
    const op = "11111111-2222-3333-4444-555555555555";
    const out = renderEnv({ merged: [], component: "api", namespace: "demo", revisionKey: "k", operationId: op });
    assert.equal(out.names.secret, `api-env-secret-${op}`);
    assert.match(out.secretYaml, new RegExp(`stardust.io/database-attach-operation: ${op}`));
    assert.throws(
      () => renderEnv({ merged: [], component: "api", namespace: "demo", revisionKey: "k", operationId: "x" }),
      /UUID/,
    );
  });
});
