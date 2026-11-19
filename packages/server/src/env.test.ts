// biome-ignore-all lint/suspicious/noTemplateCurlyInString: env values are written with ${NAME} references on purpose
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENV_REVISION_ANNOTATION, setFileMounts } from "@stardust/core";
import { MemoryRepo } from "@stardust/core/testing";
import type { Project } from "@stardust/db";
import { parse } from "yaml";
import {
  changeEnv,
  checkChange,
  commitMessage,
  EnvConflict,
  type EnvEditor,
  EnvInputError,
  readEnv,
  revealSecret,
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

    assert.equal(files["deploy/env/shop/api/runtime.yaml"], `PORT: "8080"\n`, "a new layer file is a block mapping");
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

  it("rolls out a workload that reads its secrets only as files, so a changed key is mounted", async () => {
    // No envFrom at all: the workload reads the Secret through the files volume alone.
    const filesOnly = setFileMounts(deployment("api").replace(/ {10}envFrom:\n(?: {12}- .*\n)+/, ""), {
      component: "api",
      secretName: "api-env-secret",
      mounts: [{ key: "TLS_KEY", path: "/etc/api/tls.key" }],
    }).text;
    assert.doesNotMatch(filesOnly, /envFrom/);
    const { repo, editor } = setup({ "deploy/apps/shop/api/deployment.yaml": filesOnly });
    const result = await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), setSecrets: { TLS_KEY: CANARY } },
      "alice",
    );
    assert.deepEqual(result.components[0]?.consumers, ["Deployment/api"]);
    const stamped = parse(repo.files()["deploy/apps/shop/api/deployment.yaml"] as string);
    assert.equal(
      stamped.spec.template.metadata.annotations[ENV_REVISION_ANNOTATION],
      result.components[0]?.envRevision,
    );
    assert.equal(stamped.spec.template.spec.volumes[0].name, "stardust-files", "the env change keeps the mount");
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

  it("runs one operation at a time against the repository", async () => {
    const { repo, editor } = setup();
    let active = 0;
    let most = 0;
    const head = repo.headSha.bind(repo);
    repo.headSha = async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return head();
    };
    await Promise.all([readEnv(editor, project), readEnv(editor, project), readEnv(editor, project)]);
    assert.equal(most, 1);
  });

  it("with a root, reads and writes the layers under it and never the default root's global layer", async () => {
    const { repo, editor } = setup({
      "clusters/b/env/shop/_shared/runtime.yaml": "LOG_LEVEL: debug\n",
      // Another installation's global layer: this editor must not mix it in.
      "deploy/env/_global/runtime.yaml": "FROM_OTHER_INSTALL: yes\n",
    });
    const rooted: EnvEditor = { ...editor, root: "clusters/b/env" };
    const view = await readEnv(rooted, project);
    assert.deepEqual(view.layers.find((l) => l.layer === SHARED_LAYER)?.plain, { LOG_LEVEL: "debug" });
    await changeEnv(
      rooted,
      project,
      "api",
      { expectedRevision: await revisionOf(rooted, "api"), set: { PORT: "8080" } },
      "alice",
    );
    const files = repo.files();
    assert.equal(files["clusters/b/env/shop/api/runtime.yaml"], `PORT: "8080"\n`);
    assert.equal(files["deploy/env/shop/api/runtime.yaml"], undefined);
    const configMap = parse(files["deploy/apps/shop/api/env.configmap.yaml"] as string);
    assert.deepEqual(configMap.data, { LOG_LEVEL: "debug", PORT: "8080" });
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

describe("references, literal values, multi-line values and revealing a secret", () => {
  const renderedSecret = async (codec: ReturnType<typeof fakeCodec>, files: Record<string, string>) =>
    (
      parse(await codec.decrypt(files["deploy/apps/shop/api/env.secret.enc.yaml"] as string)) as {
        stringData: Record<string, string>;
      }
    ).stringData;
  const configMapOf = (files: Record<string, string>) =>
    (parse(files["deploy/apps/shop/api/env.configmap.yaml"] as string) as { data: Record<string, string> }).data;

  it("renders references resolved, keeps a multi-line secret's lines, and stores the layer as written", async () => {
    const { repo, codec, editor } = setup();
    const toml = `[auth]\naudience = "\${AUDIENCE}"\ntoken = "\${TOKEN}"\nshared = "{{project.LOG_LEVEL}}"\n`;
    await changeEnv(
      editor,
      project,
      "api",
      {
        expectedRevision: await revisionOf(editor, "api"),
        set: { AUDIENCE: "push.example", URL: "https://${AUDIENCE}/v1" },
        setSecrets: { TOKEN: CANARY, PUSH_TOML: toml },
      },
      "alice",
    );
    const files = repo.files();
    assert.equal(configMapOf(files).URL, "https://push.example/v1");
    assert.equal(
      (await renderedSecret(codec, files)).PUSH_TOML,
      `[auth]\naudience = "push.example"\ntoken = "${CANARY}"\nshared = "info"\n`,
      "resolved, newlines and the trailing one kept",
    );
    // The layer keeps what was written; only the rendered env is resolved.
    assert.equal(parse(files["deploy/env/shop/api/runtime.yaml"] as string).URL, "https://${AUDIENCE}/v1");
  });

  it("a literal value is rendered as written, and the flag goes with its name", async () => {
    const { repo, editor } = setup();
    await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), set: { SCRIPT: "echo ${HOME}" }, literal: { SCRIPT: true } },
      "alice",
    );
    assert.equal(configMapOf(repo.files()).SCRIPT, "echo ${HOME}");
    assert.equal(repo.files()["deploy/env/shop/api/runtime.meta.yaml"], "literal:\n  - SCRIPT\n");
    const view = (await readEnv(editor, project)).layers.find((l) => l.layer === "api");
    assert.deepEqual(view?.literal, ["SCRIPT"]);
    // Turning it off resolves it: ${HOME} is not set, so the change is refused and nothing is written.
    const before = repo.commitCount();
    await assert.rejects(
      changeEnv(
        editor,
        project,
        "api",
        { expectedRevision: view?.revision as string, literal: { SCRIPT: false } },
        "alice",
      ),
      (err: Error) => err instanceof EnvInputError && /api: SCRIPT uses HOME, which is not set/.test(err.message),
    );
    assert.equal(repo.commitCount(), before);
    // Removing the name removes its flag, and the meta file with the last one.
    await changeEnv(editor, project, "api", { expectedRevision: view?.revision as string, unset: ["SCRIPT"] }, "alice");
    assert.equal(repo.files()["deploy/env/shop/api/runtime.meta.yaml"], undefined);
  });

  it("refuses a plain value that uses a secret, naming keys and never the value", async () => {
    const { repo, editor } = setup();
    await assert.rejects(
      changeEnv(
        editor,
        project,
        "api",
        {
          expectedRevision: await revisionOf(editor, "api"),
          set: { DSN: "user:${DB_PASSWORD}@db" },
          setSecrets: { DB_PASSWORD: CANARY },
        },
        "alice",
      ),
      (err: Error) =>
        err instanceof EnvInputError &&
        /DSN is a plain value and uses the secret DB_PASSWORD/.test(err.message) &&
        !err.message.includes(CANARY),
    );
    assert.equal(repo.commitCount(), 0);
  });

  it("reveals one secret by name, as stored, and refuses a name the layer does not have", async () => {
    const { editor } = setup();
    await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), setSecrets: { DB_PASSWORD: CANARY, LINES: "a\nb\n" } },
      "alice",
    );
    assert.equal(await revealSecret(editor, project, "api", "DB_PASSWORD"), CANARY);
    assert.equal(await revealSecret(editor, project, "api", "LINES"), "a\nb\n");
    await assert.rejects(revealSecret(editor, project, "api", "NOPE"), EnvInputError);
    await assert.rejects(revealSecret(editor, project, "nowhere", "DB_PASSWORD"), EnvInputError);
    await assert.rejects(revealSecret(editor, project, SHARED_LAYER, "DB_PASSWORD"), EnvInputError);
  });

  it("checks the literal field", () => {
    const base = { expectedRevision: "0".repeat(20) };
    assert.deepEqual(checkChange({ ...base, literal: { A: true } }).literal, { A: true });
    assert.throws(() => checkChange({ ...base, literal: { A: "yes" } }), /literal\.A must be true or false/);
    assert.throws(() => checkChange({ ...base, literal: { "1A": true } }), /not an environment variable name/);
    assert.throws(() => checkChange({ ...base, unset: ["A"], literal: { A: true } }), /cannot be made literal/);
  });
});

describe("checking a change", () => {
  it("refuses a plain value whose name says it is a secret, unless declared public", () => {
    const rev = "a".repeat(20);
    assert.throws(
      () => checkChange({ expectedRevision: rev, set: { GITHUB_TOKEN: "ghp_x", PORT: "80" } }),
      /GITHUB_TOKEN looks like a secret: save it as a secret, or list it in plainOnPurpose/,
    );
    assert.doesNotThrow(() =>
      checkChange({ expectedRevision: rev, set: { GITHUB_TOKEN: "public" }, plainOnPurpose: ["GITHUB_TOKEN"] }),
    );
    assert.doesNotThrow(() => checkChange({ expectedRevision: rev, setSecrets: { GITHUB_TOKEN: "ghp_x" } }));
  });

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

describe("adopting env made by hand", () => {
  const dir = "deploy/apps/shop/api";
  const codec = fakeCodec();
  const sealed = async (doc: string) => (await codec.encryptIfChanged(null, doc)).document;
  const handFiles = async (envSecret?: string) => {
    const other = await sealed(
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db-auth\n  namespace: shop\nstringData:\n  POSTGRES_PASSWORD: pg-pass\n",
    );
    const pull = await sealed(
      'apiVersion: v1\nkind: Secret\nmetadata:\n  name: pull\n  namespace: shop\ntype: kubernetes.io/dockerconfigjson\nstringData:\n  ".dockerconfigjson": "{}"\n',
    );
    const mine =
      envSecret ??
      (await sealed(
        `apiVersion: v1\nkind: Secret\nmetadata:\n  name: api-env-secret\n  namespace: shop\ntype: Opaque\nstringData:\n  DB_URL: ${CANARY}\n`,
      ));
    return {
      other,
      pull,
      files: {
        [`${dir}/configmap.yaml`]:
          'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: api-env\n  namespace: shop\ndata:\n  LOG_LEVEL: debug\n  REGION: "eu"\n',
        [`${dir}/secrets.enc.yaml`]: `${other}---\n${mine}---\n${pull}`,
        [`${dir}/kustomization.yaml`]:
          "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n- configmap.yaml   # api-env\n- secrets.enc.yaml # db-auth, api-env-secret, pull\n- deployment.yaml\n",
      },
    };
  };

  it("lists it by name and keys, never a value", async () => {
    const { editor } = setup((await handFiles()).files);
    const { adoptable } = await readEnv(editor, project);
    assert.deepEqual(adoptable, [
      {
        component: "api",
        path: `${dir}/configmap.yaml`,
        kind: "ConfigMap",
        name: "api-env",
        keys: ["LOG_LEVEL", "REGION"],
      },
      { component: "api", path: `${dir}/secrets.enc.yaml`, kind: "Secret", name: "api-env-secret", keys: ["DB_URL"] },
    ]);
    assert.ok(!JSON.stringify(adoptable).includes(CANARY));
  });

  it("moves it into the component's layer with the next change, in one commit, keeping the other Secrets' values", async () => {
    const hand = await handFiles();
    const { repo, editor } = setup(hand.files);
    const result = await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), set: { PORT: "8080" } },
      "alice",
    );
    assert.equal(result.status, "committed");
    assert.equal(repo.commitCount(), 1);
    assert.deepEqual(
      result.adopted.map((h) => `${h.kind} ${h.name}`),
      ["ConfigMap api-env", "Secret api-env-secret"],
    );
    const files = repo.files();
    assert.equal(files[`${dir}/configmap.yaml`], undefined, "a file left empty is removed");
    // One MAC covers a SOPS file: what is left is encrypted again, with the same values.
    const left = await codec.decrypt(files[`${dir}/secrets.enc.yaml`] as string);
    assert.deepEqual(
      left
        .split(/^---\s*$/m)
        .filter((d) => d.trim() !== "")
        .map((d) => (parse(d) as { metadata: { name: string } }).metadata.name),
      ["db-auth", "pull"],
    );
    assert.match(left, /POSTGRES_PASSWORD: pg-pass/);
    assert.ok(!(files[`${dir}/secrets.enc.yaml`] as string).includes("pg-pass"), "and still encrypted");
    const listed = parse(files[`${dir}/kustomization.yaml`] as string).resources;
    assert.deepEqual(listed, ["secrets.enc.yaml", "deployment.yaml", "env.configmap.yaml", "env.secret.enc.yaml"]);
    // The component's value wins over the shared layer's, as the hand-made ConfigMap did.
    assert.deepEqual(parse(files[`${dir}/env.configmap.yaml`] as string).data, {
      LOG_LEVEL: "debug",
      PORT: "8080",
      REGION: "eu",
    });
    assert.deepEqual(parse(files["deploy/env/shop/api/runtime.yaml"] as string), {
      LOG_LEVEL: "debug",
      REGION: "eu",
      PORT: "8080",
    });
    const layerSecrets = parse(await codec.decrypt(files["deploy/env/shop/api/runtime.secret.enc.yaml"] as string));
    assert.deepEqual(layerSecrets.stringData, { DB_URL: CANARY });
    assert.ok(files[`${dir}/env.secret.enc.yaml`]?.includes("DB_URL"));
    for (const [path, text] of Object.entries(files)) assert.ok(!text.includes(CANARY), path);
    assert.match(repo.log.join("\n"), /adopt Secret api-env-secret from secrets\.enc\.yaml \(DB_URL\)/);
    assert.ok(!repo.log.join("\n").includes(CANARY));
    assert.deepEqual((await readEnv(editor, project)).adoptable, []);
  });

  it("adopts with nothing else to change when asked, and then has nothing left to do", async () => {
    const { repo, editor } = setup((await handFiles()).files);
    const change = checkChange({ expectedRevision: await revisionOf(editor, "api"), adopt: true });
    assert.equal((await changeEnv(editor, project, "api", change, "alice")).status, "committed");
    const again = checkChange({ expectedRevision: await revisionOf(editor, "api"), adopt: true });
    const second = await changeEnv(editor, project, "api", again, "alice");
    assert.equal(second.status, "no_change");
    assert.deepEqual(second.adopted, []);
    assert.equal(repo.commitCount(), 1, "the second adoption committed nothing");
  });

  it("a shared change adopts into each component's own layer", async () => {
    const { repo, editor } = setup((await handFiles()).files);
    const shared = await revisionOf(editor, SHARED_LAYER);
    await changeEnv(editor, project, SHARED_LAYER, { expectedRevision: shared, set: { TZ: "UTC" } }, "alice");
    const files = repo.files();
    assert.equal(parse(files["deploy/env/shop/api/runtime.yaml"] as string).REGION, "eu");
    assert.equal(files["deploy/env/shop/web/runtime.yaml"], undefined, "web had nothing made by hand");
  });

  it("keeps what the layer already says, and decodes a Secret's data", async () => {
    const data = await sealed(
      `apiVersion: v1\nkind: Secret\nmetadata:\n  name: api-env-secret\n  namespace: shop\ndata:\n  TOKEN: ${Buffer.from("tok").toString("base64")}\n`,
    );
    // The fake codec only encrypts stringData: data stays base64, as a real Secret's would after decryption.
    const { repo, editor } = setup({
      ...(await handFiles(data)).files,
      "deploy/env/shop/api/runtime.yaml": "REGION: us\n",
    });
    await changeEnv(
      editor,
      project,
      "api",
      { expectedRevision: await revisionOf(editor, "api"), adopt: true },
      "alice",
    );
    assert.equal(parse(repo.files()["deploy/env/shop/api/runtime.yaml"] as string).REGION, "us");
    const secrets = parse(await codec.decrypt(repo.files()["deploy/env/shop/api/runtime.secret.enc.yaml"] as string));
    assert.deepEqual(secrets.stringData, { TOKEN: "tok" });
  });

  it("refuses a Secret by that name that is not env values, and writes nothing", async () => {
    const odd =
      'apiVersion: v1\nkind: Secret\nmetadata:\n  name: api-env-secret\n  namespace: shop\ntype: kubernetes.io/tls\nstringData:\n  "tls.crt": x\n';
    const { repo, editor } = setup((await handFiles(await sealed(odd))).files);
    await assert.rejects(
      changeEnv(
        editor,
        project,
        "api",
        { expectedRevision: await revisionOf(editor, "api"), set: { A: "1" } },
        "alice",
      ),
      (err: Error) => err instanceof EnvInputError && /kubernetes\.io\/tls Secret/.test(err.message),
    );
    assert.equal(repo.commitCount(), 0);
  });

  it("says why when the hand-made file is not encrypted to stardust's key, and writes nothing", async () => {
    const { repo, editor } = setup((await handFiles()).files);
    const failing: EnvEditor = {
      ...editor,
      codec: {
        ...editor.codec,
        decrypt: async (d) => {
          if (d.includes("db-auth")) throw new Error("sops --decrypt failed (128): Failed to get the data key");
          return editor.codec.decrypt(d);
        },
      },
    };
    await assert.rejects(
      changeEnv(failing, project, "api", { expectedRevision: await revisionOf(editor, "api"), adopt: true }, "alice"),
      (err: Error) =>
        err instanceof EnvInputError &&
        /cannot decrypt deploy\/apps\/shop\/api\/secrets\.enc\.yaml to adopt api-env-secret: the file is not encrypted to stardust's key/.test(
          err.message,
        ),
    );
    assert.equal(repo.commitCount(), 0);
  });
});
