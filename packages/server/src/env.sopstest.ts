/**
 * The env editor against the real sops binary (SOPS_BIN) with a fresh age key
 * (AGE_KEYGEN): what a change writes decrypts to the values given, keys stay
 * readable for a masked read, and setting the same values again commits
 * nothing although sops would encrypt them differently.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MemoryRepo } from "@stardust/core/testing";
import type { Project } from "@stardust/db";
import { decrypt, encrypt, encryptIfChanged, type SopsOptions } from "@stardust/plugin-secrets-sops-age";
import { parse } from "yaml";
import { changeEnv, type EnvEditor, readEnv } from "./env.ts";

const bin = process.env.SOPS_BIN;
const keygen = process.env.AGE_KEYGEN;
if (!bin || !keygen) throw new Error("SOPS_BIN and AGE_KEYGEN must point to sops and age-keygen");

const SECRET = `canary-${Date.now()}`;
let dir: string;
let opts: SopsOptions;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "env-sops-test-"));
  const keyFile = join(dir, "keys.txt");
  execFileSync(keygen, ["-o", keyFile], { stdio: "ignore" });
  const recipient = /public key: (age1[0-9a-z]+)/.exec(readFileSync(keyFile, "utf8"))?.[1];
  assert.ok(recipient);
  opts = { bin, ageKeyFile: keyFile, recipients: [recipient] };
});
after(() => rmSync(dir, { recursive: true, force: true }));

const project: Project = {
  id: "shop",
  name: "shop",
  githubRepo: null,
  pipelineDef: null,
  metadata: {},
  components: [{ name: "api", pipeline: "C", deployDir: "deploy/shop/api" }],
};

describe("env editing with sops", () => {
  it("writes layers and the rendered Secret that decrypt to the values; the same values again commit nothing", async () => {
    const repo = new MemoryRepo({
      "deploy/shop/api/deployment.yaml":
        "kind: Deployment\nmetadata: { name: api, namespace: shop }\nspec:\n  template:\n    spec:\n      containers:\n        - name: api\n          envFrom: [{ secretRef: { name: api-env-secret } }]\n",
      "deploy/shop/api/kustomization.yaml": "resources:\n- deployment.yaml\n",
    });
    const editor: EnvEditor = {
      repo,
      codec: { decrypt: (d) => decrypt(d, opts), encryptIfChanged: (c, p) => encryptIfChanged(c, p, opts) },
      revisionKey: "k",
    };
    const revision = async () =>
      (await readEnv(editor, project)).layers.find((l) => l.layer === "api")?.revision as string;
    const change = { setSecrets: { DB_PASSWORD: SECRET }, set: { PORT: "8080" } };
    assert.equal(
      (await changeEnv(editor, project, "api", { ...change, expectedRevision: await revision() }, "a")).status,
      "committed",
    );

    const files = repo.files();
    for (const [path, text] of Object.entries(files))
      assert.ok(!text.includes(SECRET), `${path} holds the value in plain text`);
    const layer = parse(await decrypt(files["deploy/env/shop/api/runtime.secret.enc.yaml"] as string, opts));
    assert.equal(layer.stringData.DB_PASSWORD, SECRET);
    const rendered = parse(await decrypt(files["deploy/shop/api/env.secret.enc.yaml"] as string, opts));
    assert.equal(rendered.stringData.DB_PASSWORD, SECRET);
    assert.equal(rendered.metadata.name, "api-env-secret");
    // Keys stay readable: a read lists the name without decrypting.
    assert.deepEqual((await readEnv(editor, project)).layers.find((l) => l.layer === "api")?.secrets, ["DB_PASSWORD"]);

    const commits = repo.commitCount();
    const again = await changeEnv(editor, project, "api", { ...change, expectedRevision: await revision() }, "a");
    assert.equal(again.status, "no_change");
    assert.equal(repo.commitCount(), commits);
  });

  it("adopts a hand-made env Secret out of a SOPS file of several documents, which decrypts only whole", async () => {
    const hand = await encrypt(
      `apiVersion: v1\nkind: Secret\nmetadata:\n  name: db-auth\n  namespace: shop\nstringData:\n  POSTGRES_PASSWORD: pg-${SECRET}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: api-env-secret\n  namespace: shop\nstringData:\n  DB_URL: ${SECRET}\n`,
      opts,
    );
    const repo = new MemoryRepo({
      "deploy/shop/api/deployment.yaml":
        "kind: Deployment\nmetadata: { name: api, namespace: shop }\nspec:\n  template:\n    spec:\n      containers:\n        - name: api\n          envFrom: [{ secretRef: { name: api-env-secret } }]\n",
      "deploy/shop/api/secrets.enc.yaml": hand,
      "deploy/shop/api/kustomization.yaml":
        "resources:\n- secrets.enc.yaml # db-auth, api-env-secret\n- deployment.yaml\n",
    });
    const editor: EnvEditor = {
      repo,
      codec: { decrypt: (d) => decrypt(d, opts), encryptIfChanged: (c, p) => encryptIfChanged(c, p, opts) },
      revisionKey: "k",
    };
    const view = await readEnv(editor, project);
    assert.deepEqual(
      view.adoptable.map((h) => `${h.name} ${h.keys.join(",")}`),
      ["api-env-secret DB_URL"],
    );
    const revision = view.layers.find((l) => l.layer === "api")?.revision as string;
    const result = await changeEnv(editor, project, "api", { expectedRevision: revision, adopt: true }, "alice");
    assert.equal(result.status, "committed");
    const files = repo.files();
    const left = await decrypt(files["deploy/shop/api/secrets.enc.yaml"] as string, opts);
    assert.match(left, /name: db-auth/);
    assert.match(left, new RegExp(`POSTGRES_PASSWORD: pg-${SECRET}`));
    assert.doesNotMatch(left, /api-env-secret/);
    const layer = parse(await decrypt(files["deploy/env/shop/api/runtime.secret.enc.yaml"] as string, opts));
    assert.equal(layer.stringData.DB_URL, SECRET);
    for (const [path, text] of Object.entries(files)) assert.ok(!text.includes(SECRET), path);
  });
});
