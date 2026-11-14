import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { PluginContext, Ports } from "@stardust/core";
import { plugin } from "./index.ts";

const lines: string[] = [];
const context = (config: Record<string, unknown>, ports: Partial<Ports> = {}): PluginContext => ({
  config,
  resolveSecret: async (_ref, at) => `secret for ${at}`,
  log: { debug() {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  publicUrl: "https://stardust.example.com",
  ports,
});

const recipients = [`age1${"q".repeat(58)}`];

it("is off, and says so, when the age identity is not mounted", async () => {
  lines.length = 0;
  const ports = await plugin.provides?.create(context({ ageKeyFile: "/nonexistent/keys.txt", recipients }));
  assert.deepEqual(ports, {});
  assert.deepEqual(lines, ["secrets-sops-age is off: the age identity is not mounted"]);
});

it("derives a revision key from the identity: the same key gives the same, another key another", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sops-provides-"));
  try {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    writeFileSync(a, "AGE-SECRET-KEY-A\n");
    writeFileSync(b, "AGE-SECRET-KEY-B\n");
    const key = async (file: string) =>
      (await plugin.provides?.create(context({ ageKeyFile: file, recipients })))?.cipher?.revisionKey;
    assert.match((await key(a)) ?? "", /^[0-9a-f]{64}$/);
    assert.equal(await key(a), await key(a));
    assert.notEqual(await key(a), await key(b));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
