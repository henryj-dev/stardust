// biome-ignore-all lint/suspicious/noTemplateCurlyInString: env values are written with ${NAME} references on purpose
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EnvReferenceError, mergeEnv } from "./merge.ts";

// Layers as files; a "secret" file here is already the decrypted document (decrypt is the identity).
function layers(files: Record<string, string>) {
  return {
    read: async (path: string) => files[path] ?? null,
    decrypt: async (doc: string) => doc,
    project: "pico",
    component: "push",
  };
}
const secret = (values: Record<string, string>) =>
  `apiVersion: v1\nkind: Secret\nstringData:\n${Object.entries(values)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n`;
const resolved = async (files: Record<string, string>, key: string) =>
  (await mergeEnv(layers(files))).find((e) => e.scope === "runtime" && e.key === key)?.value;

const SHARED = "deploy/env/pico/_shared/runtime";
const OWN = "deploy/env/pico/push/runtime";

describe("references in env values", () => {
  it("resolves ${NAME} from what the component ends up with, and {{project.NAME}} from the project level", async () => {
    const files = {
      [`${SHARED}.yaml`]: "HOST: shared.example\nPORT: '5432'\n",
      [`${OWN}.yaml`]:
        "HOST: own.example\nURL: 'postgres://${HOST}:${PORT}/app'\nUPSTREAM: 'https://{{ project.HOST }}'\n",
    };
    assert.equal(await resolved(files, "URL"), "postgres://own.example:5432/app");
    assert.equal(await resolved(files, "UPSTREAM"), "https://shared.example", "project level, not the override");
  });

  it("resolves inside a multi-line secret, and a secret may use a plain value", async () => {
    const files = {
      [`${OWN}.yaml`]: "AUDIENCE: notification.example\n",
      [`${OWN}.secret.enc.yaml`]: secret({
        TOKEN: "s3cr3t",
        PUSH_TOML: '[auth]\naudience = "${AUDIENCE}"\ntoken = "${TOKEN}"\n',
      }),
    };
    assert.equal(await resolved(files, "PUSH_TOML"), '[auth]\naudience = "notification.example"\ntoken = "s3cr3t"\n');
  });

  it("keeps a literal value as it is, and $${ is a literal ${", async () => {
    const files = {
      [`${OWN}.yaml`]: "A: x\nRAW: '${A} and ${MISSING}'\nESCAPED: 'cost $${A}'\n",
      [`${OWN}.meta.yaml`]: "literal: [RAW]\n",
    };
    assert.equal(await resolved(files, "RAW"), "${A} and ${MISSING}");
    assert.equal(await resolved(files, "ESCAPED"), "cost ${A}");
  });

  it("refuses a missing name, a cycle, and a plain value that uses a secret — naming keys, not values", async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ [`${OWN}.yaml`]: "URL: '${NOPE}'\n" }, /URL uses NOPE, which is not set/],
      [{ [`${OWN}.yaml`]: "URL: '{{project.NOPE}}'\n" }, /URL uses project\.NOPE, which is not set/],
      [{ [`${OWN}.yaml`]: "A: '${B}'\nB: '${A}'\n" }, /refer to each other/],
      [
        { [`${OWN}.yaml`]: "URL: 'x${TOKEN}'\n", [`${OWN}.secret.enc.yaml`]: secret({ TOKEN: "s3cr3t" }) },
        /URL is a plain value and uses the secret TOKEN/,
      ],
      [
        { [`${SHARED}.secret.enc.yaml`]: secret({ KEY: "s3cr3t" }), [`${OWN}.yaml`]: "URL: '{{project.KEY}}'\n" },
        /uses the secret project\.KEY/,
      ],
    ];
    for (const [files, reason] of cases) {
      await assert.rejects(mergeEnv(layers(files)), (err: Error) => {
        assert.ok(err instanceof EnvReferenceError, String(err));
        assert.match(err.message, reason);
        assert.doesNotMatch(err.message, /s3cr3t/, "a value never appears in the reason");
        return true;
      });
    }
  });

  it("leaves a masked read as it is", async () => {
    const merged = await mergeEnv({
      ...layers({ [`${OWN}.yaml`]: "URL: '${NOPE}'\n" }),
      masked: true,
    });
    assert.equal(merged.find((e) => e.key === "URL")?.value, "${NOPE}");
  });
});
