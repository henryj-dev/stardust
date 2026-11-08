import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENV_REVISION_ANNOTATION } from "@stardust/core";
import type { Project } from "@stardust/db";
import { MemoryRepo } from "@stardust/plugin-gitops-git/testing";
import { parse } from "yaml";
import {
  changeEnv,
  checkChange,
  commitMessage,
  EnvConflict,
  type EnvEditor,
  EnvInputError,
  readEnv,
  SHARED_LAYER,
} from "./env.ts";
import { fakeCodec } from "./env-testing.ts";

// A secret value that must never come back out in plain text.
const CANARY = "canary-secret-7Hq2";

const project: Project = {
  id: "shop",
  name: "Shop",
  githubRepo: "acme/shop",
  pipelineDef: null,
  metadata: {},
  components: [
    { name: "api", pipeline: "C", deployDir: "deploy/apps/shop/api" },
    { name: "web", pipeline: "C", deployDir: "deploy/apps/shop/web" },
  ],
};

const deployment = (name: string) => `# keep this comment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: shop
spec:
  template:
    spec:
      containers:
        - name: ${name}
          image: registry.example/shop/${name}:1
          envFrom:
            - configMapRef: { name: ${name}-env }
            - secretRef: { name: ${name}-env-secret }
`;
const kustomization =
  "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n- deployment.yaml\n";

function setup(extra: Record<string, string> = {}) {
  const repo = new MemoryRepo({
    "deploy/env/shop/_shared/runtime.yaml": "# shared\nLOG_LEVEL: info\n",
    "deploy/apps/shop/api/deployment.yaml": deployment("api"),
    "deploy/apps/shop/api/kustomization.yaml": kustomization,
    "deploy/apps/shop/web/deployment.yaml": deployment("web"),
    "deploy/apps/shop/web/kustomization.yaml": kustomization,
    ...extra,
  });
  const codec = fakeCodec();
  const editor: EnvEditor = { repo, codec, revisionKey: "test-key", cas: { sleep: async () => {} } };
  return { repo, codec, editor };
}

const revisionOf = async (editor: EnvEditor, layer: string) =>
  (await readEnv(editor, project)).layers.find((l) => l.layer === layer)?.revision as string;

describe("env editing", () => {
  it("sets a value and a secret in one commit: layer files, rendered env, kustomization and rollout stamp", async () => {
    const { repo, editor } = setup();
    const result = await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), set: { PORT: "8080" }, setSecrets: { DB_PASSWORD: CANARY } },
      "alice",
    );
    assert.equal(result.status, "committed");
    assert.equal(repo.commitCount(), 1);
    const files = repo.files();

    assert.deepEqual(parse(files["deploy/env/shop/api/runtime.yaml"] as string), { PORT: "8080" });
    assert.ok(files["deploy/env/shop/api/runtime.secret.enc.yaml"]?.includes("DB_PASSWORD"));
    const configMap = parse(files["deploy/apps/shop/api/env.configmap.yaml"] as string);
    // The shared layer comes along; the component's own value is there.
    assert.deepEqual(configMap.data, { LOG_LEVEL: "info", PORT: "8080" });
    assert.equal(configMap.metadata.namespace, "shop");
    assert.ok(files["deploy/apps/shop/api/env.secret.enc.yaml"]?.includes("DB_PASSWORD"));
    assert.match(
      files["deploy/apps/shop/api/kustomization.yaml"] as string,
      /- env\.configmap\.yaml\n- env\.secret\.enc\.yaml/,
    );

    const stamped = files["deploy/apps/shop/api/deployment.yaml"] as string;
    assert.ok(stamped.startsWith("# keep this comment"), "comments stay");
    const annotations = parse(stamped).spec.template.metadata.annotations;
    assert.equal(annotations[ENV_REVISION_ANNOTATION], result.components[0]?.envRevision);
    assert.deepEqual(result.components, [
      { name: "api", envRevision: result.components[0]?.envRevision, consumers: ["Deployment/api"] },
    ]);
    // Another component's files are not touched by a component layer.
    assert.equal(files["deploy/apps/shop/web/env.configmap.yaml"], undefined);

    // The secret value is in no file in plain text, and not in the commit message.
    for (const [path, text] of Object.entries(files)) assert.ok(!text.includes(CANARY), path);
    assert.ok(!repo.log.join("\n").includes(CANARY));
  });

  it("reads plain values and secret names, never secret values", async () => {
    const { editor } = setup();
    await changeEnv(
      editor,
      project,
      SHARED_LAYER,
      { expectedRevision: await revisionOf(editor, SHARED_LAYER), setSecrets: { API_KEY: CANARY } },
      "alice",
    );
    const read = await readEnv(editor, project);
    const shared = read.layers.find((l) => l.layer === SHARED_LAYER);
    assert.deepEqual(shared?.plain, { LOG_LEVEL: "info" });
    assert.deepEqual(shared?.secrets, ["API_KEY"]);
    assert.ok(!JSON.stringify(read).includes(CANARY));
    assert.deepEqual(
      read.layers.map((l) => l.layer),
      ["_shared", "api", "web"],
    );
  });

  it("a shared change renders every component", async () => {
    const { repo, editor } = setup();
    const result = await changeEnv(
      editor,
      project,
      SHARED_LAYER,
      { expectedRevision: await revisionOf(editor, SHARED_LAYER), set: { LOG_LEVEL: "debug" } },
      "alice",
    );
    assert.deepEqual(
      result.components.map((c) => c.name),
      ["api", "web"],
    );
    for (const c of ["api", "web"]) {
      assert.deepEqual(parse(repo.files()[`deploy/apps/shop/${c}/env.configmap.yaml`] as string).data, {
        LOG_LEVEL: "debug",
      });
    }
    assert.match(repo.files()["deploy/env/shop/_shared/runtime.yaml"] as string, /^# shared\n/);
  });

  it("refuses a change made against an older revision, and writes nothing", async () => {
    const { repo, editor } = setup();
    const stale = await revisionOf(editor, SHARED_LAYER);
    repo.push({ "deploy/env/shop/_shared/runtime.yaml": "LOG_LEVEL: warn\n" }, "someone else");
    await assert.rejects(
      changeEnv(editor, project, SHARED_LAYER, { expectedRevision: stale, set: { LOG_LEVEL: "debug" } }, "alice"),
      EnvConflict,
    );
    assert.equal(repo.files()["deploy/env/shop/_shared/runtime.yaml"], "LOG_LEVEL: warn\n");
  });

  it("retries when an unrelated commit lands first; conflicts when the layer itself changed", async () => {
    const { repo, editor } = setup();
    let once = true;
    repo.beforeCommit = () => {
      if (once) repo.push({ "README.md": "unrelated" });
      once = false;
    };
    const ok = await changeEnv(
      editor,
      project,
      "web",
      { expectedRevision: await revisionOf(editor, "web"), set: { A: "1" } },
      "alice",
    );
    assert.equal(ok.status, "committed");
    assert.equal(repo.files()["README.md"], "unrelated");

    let race = true;
    repo.beforeCommit = () => {
      if (race) repo.push({ "deploy/env/shop/web/runtime.yaml": "A: '2'\n" });
      race = false;
    };
    await assert.rejects(
      changeEnv(
        editor,
        project,
        "web",
        { expectedRevision: await revisionOf(editor, "web"), set: { A: "3" } },
        "alice",
      ),
      EnvConflict,
    );
    repo.beforeCommit = null;
  });

  it("setting what is already there commits nothing: re-encryption alone is not a change", async () => {
    const { repo, codec, editor } = setup();
    const change = { setSecrets: { TOKEN_X: CANARY }, set: { PORT: "1" } };
    await changeEnv(editor, project, "api", { ...change, expectedRevision: await revisionOf(editor, "api") }, "alice");
    const commits = repo.commitCount();
    const before = codec.encryptions;
    const again = await changeEnv(
      editor,
      project,
      "api",
      { ...change, expectedRevision: await revisionOf(editor, "api") },
      "alice",
    );
    assert.equal(again.status, "no_change");
    assert.equal(again.commit, null);
    assert.equal(repo.commitCount(), commits);
    assert.equal(codec.encryptions, before, "nothing was re-encrypted");
  });

  it("a name is plain or secret in a layer, not both; unsetting the last value removes the file", async () => {
    const { repo, editor } = setup();
    await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), set: { X: "1" } },
      "a",
    );
    await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), setSecrets: { X: CANARY } },
      "a",
    );
    let view = (await readEnv(editor, project)).layers.find((l) => l.layer === "api");
    assert.deepEqual([view?.plain, view?.secrets], [{}, ["X"]]);
    assert.equal(repo.files()["deploy/env/shop/api/runtime.yaml"], undefined);
    await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), unsetSecrets: ["X"] },
      "a",
    );
    view = (await readEnv(editor, project)).layers.find((l) => l.layer === "api");
    assert.deepEqual(view?.secrets, []);
    assert.equal(repo.files()["deploy/env/shop/api/runtime.secret.enc.yaml"], undefined);
  });

  it("refuses an unknown layer and a component whose namespace cannot be told", async () => {
    const { editor } = setup({ "deploy/apps/shop/web/deployment.yaml": "kind: Service\nmetadata: { name: web }\n" });
    await assert.rejects(
      changeEnv(editor, project, "db", { expectedRevision: "0".repeat(20), set: { A: "1" } }, "a"),
      EnvInputError,
    );
    await assert.rejects(
      changeEnv(editor, project, "web", { expectedRevision: await revisionOf(editor, "web"), set: { A: "1" } }, "a"),
      /namespace/,
    );
  });

  it("the commit message names keys, never values", () => {
    const message = commitMessage(
      "shop",
      "api",
      { expectedRevision: "x", set: { PORT: "1" }, setSecrets: { PASS: CANARY }, unsetSecrets: ["OLD"] },
      "alice",
    );
    assert.match(message, /set PORT; set secrets PASS; unset secrets OLD/);
    assert.ok(!message.includes(CANARY));
  });
});

describe("checking a change", () => {
  const rev = "a".repeat(20);
  it("accepts names and text values", () => {
    assert.deepEqual(checkChange({ expectedRevision: rev, set: { A_1: "x" }, unsetSecrets: ["B"] }), {
      expectedRevision: rev,
      set: { A_1: "x" },
      unset: [],
      setSecrets: {},
      unsetSecrets: ["B"],
    });
  });
  for (const [why, body] of [
    ["no revision", { set: { A: "1" } }],
    ["unknown field", { expectedRevision: rev, values: {} }],
    ["bad name", { expectedRevision: rev, set: { "A-B": "1" } }],
    ["name with a newline", { expectedRevision: rev, setSecrets: { "A\nkind: x": "1" } }],
    ["non-text value", { expectedRevision: rev, set: { A: 1 } }],
    ["too long", { expectedRevision: rev, setSecrets: { A: "x".repeat(32 * 1024 + 1) } }],
    ["nothing", { expectedRevision: rev }],
    ["twice", { expectedRevision: rev, set: { A: "1" }, unsetSecrets: ["A"] }],
    ["not a list", { expectedRevision: rev, unset: "A" }],
  ] as const) {
    it(`refuses ${why}`, () => {
      assert.throws(() => checkChange(body), EnvInputError);
    });
  }
  it("a refusal never quotes a value", () => {
    try {
      checkChange({ expectedRevision: rev, setSecrets: { A: CANARY.repeat(5000) } });
      assert.fail("accepted");
    } catch (err) {
      assert.ok(!(err as Error).message.includes(CANARY));
    }
  });
});
