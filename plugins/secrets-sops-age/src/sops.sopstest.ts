/**
 * Against the real sops binary (SOPS_BIN) with a fresh age key (AGE_KEYGEN).
 * Run with `pnpm run test:sops`; it fails rather than skips without them.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { secretKeysOf, secretSetDocument, secretValuesOf } from "@stardust/core";
import { parse } from "yaml";
import { decrypt, encrypt, encryptIfChanged, type SopsOptions } from "./sops.ts";

const bin = process.env.SOPS_BIN;
const keygen = process.env.AGE_KEYGEN;
if (!bin || !keygen) throw new Error("SOPS_BIN and AGE_KEYGEN must point to sops and age-keygen");

let dir: string;
let opts: SopsOptions;
const PLAIN = `apiVersion: v1
kind: Secret
metadata:
  name: api-env-secret
  namespace: demo
type: Opaque
stringData:
  "DB_PASSWORD": "hunter2-${Date.now()}"
  "API_KEY": "k"
`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "sops-test-"));
  const keyFile = join(dir, "keys.txt");
  execFileSync(keygen, ["-o", keyFile], { stdio: "ignore" });
  const recipient = /public key: (age1[0-9a-z]+)/.exec(readFileSync(keyFile, "utf8"))?.[1];
  assert.ok(recipient);
  opts = { bin, ageKeyFile: keyFile, recipients: [recipient] };
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("sops with age", () => {
  it("encrypts only stringData; names stay readable; decrypting gives the values back", async () => {
    const enc = await encrypt(PLAIN, opts);
    const doc = parse(enc) as { metadata: { name: string }; stringData: Record<string, string>; sops: unknown };
    assert.equal(doc.metadata.name, "api-env-secret", "metadata is not encrypted");
    assert.deepEqual(Object.keys(doc.stringData).sort(), ["API_KEY", "DB_PASSWORD"], "keys stay readable");
    assert.ok(
      Object.values(doc.stringData).every((v) => v.startsWith("ENC[")),
      "values are encrypted",
    );
    assert.ok(!enc.includes("hunter2"), "the plain value is not in the ciphertext");
    const back = parse(await decrypt(enc, opts)) as { stringData: Record<string, string> };
    assert.deepEqual(back.stringData, (parse(PLAIN) as { stringData: Record<string, string> }).stringData);
  });

  it("seals binary secret files under data: bytes come back as they went in, keys stay readable", async () => {
    const kek = Buffer.from([0, 255, 1, 254, 0x80, 0x0a, 0x0d, 0x22, 0x5c]);
    const plain = secretSetDocument({ component: "api", namespace: "demo", name: "kek", data: { key: kek } });
    const enc = await encrypt(plain, opts);
    const doc = parse(enc) as { data: Record<string, string> };
    assert.ok(doc.data.key?.startsWith("ENC["), "the value is encrypted");
    assert.deepEqual(secretKeysOf(enc), ["key"], "the key name is read without decrypting");
    const back = secretValuesOf(await decrypt(enc, opts));
    assert.ok(back.key?.equals(kek), "the same bytes");
    assert.equal((await encryptIfChanged(enc, plain, opts)).changed, false);
  });

  it("encrypting twice gives different ciphertext; encryptIfChanged sees that nothing changed", async () => {
    const first = await encrypt(PLAIN, opts);
    assert.notEqual(await encrypt(PLAIN, opts), first, "sops output is not deterministic");
    const same = await encryptIfChanged(first, PLAIN, opts);
    assert.equal(same.changed, false);
    assert.equal(same.document, first, "the existing ciphertext is kept");
    const changed = await encryptIfChanged(first, PLAIN.replace('"k"', '"k2"'), opts);
    assert.equal(changed.changed, true);
    assert.notEqual(changed.document, first);
  });

  it("writes no plain-text file while working", async () => {
    // Only regular files that appeared during the call are read: a shared /tmp
    // can hold FIFOs and sockets, and reading a FIFO blocks forever.
    const existing = new Set(readdirSync(tmpdir()));
    await encryptIfChanged(await encrypt(PLAIN, opts), PLAIN.replace('"k"', '"k3"'), opts);
    const created = readdirSync(tmpdir()).filter((f) => !existing.has(f));
    const leaked = created.filter((f) => {
      const path = join(tmpdir(), f);
      return statSync(path).isFile() && readFileSync(path, "utf8").includes("hunter2");
    });
    assert.deepEqual(leaked, []);
  });

  it("refuses to encrypt without a valid recipient, and fails to decrypt with the wrong key", async () => {
    await assert.rejects(encrypt(PLAIN, { ...opts, recipients: [] }), /at least one age recipient/);
    await assert.rejects(encrypt(PLAIN, { ...opts, recipients: ["age1nope"] }), /not an age recipient/);
    const other = join(dir, "other.txt");
    execFileSync(keygen as string, ["-o", other], { stdio: "ignore" });
    const enc = await encrypt(PLAIN, opts);
    await assert.rejects(
      decrypt(enc, { ...opts, ageKeyFile: other }),
      (err: Error) => !err.message.includes("hunter2"),
    );
  });
});
