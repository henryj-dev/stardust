import assert from "node:assert/strict";
import { it } from "node:test";
import { readSecretFileForm, SecretFileFormError } from "./secret-file-form.ts";

const form = (entries: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

it("generates by default, uploads bytes as base64, and needs a confirmation to replace or delete", async () => {
  assert.deepEqual(await readSecretFileForm(form({ op: "add", set: "kek", key: "key", bytes: "32" })), {
    op: "add",
    set: "kek",
    key: "key",
    body: { generate: { bytes: 32, encoding: "raw" } },
  });
  const file = new File([new Uint8Array([0, 255, 10])], "kek.bin");
  const up = await readSecretFileForm(form({ op: "add", set: "kek", key: "key", source: "upload", file }));
  assert.deepEqual(up.op !== "delete" && up.body, { value: Buffer.from([0, 255, 10]).toString("base64") });
  await assert.rejects(readSecretFileForm(form({ op: "replace", set: "kek", key: "key" })), SecretFileFormError);
  await assert.rejects(readSecretFileForm(form({ op: "delete", set: "kek", key: "key" })), SecretFileFormError);
  assert.deepEqual(await readSecretFileForm(form({ op: "delete", set: "kek", key: "key", confirm: "on" })), {
    op: "delete",
    set: "kek",
    key: "key",
  });
  await assert.rejects(readSecretFileForm(form({ op: "add", set: "", key: "key" })), SecretFileFormError);
});
