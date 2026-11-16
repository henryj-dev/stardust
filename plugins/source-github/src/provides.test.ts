import assert from "node:assert/strict";
import { it } from "node:test";
import type { PluginContext, Ports } from "@stardust/core";
import { plugin } from "./index.ts";

const lines: string[] = [];
const context = (config: Record<string, unknown>, ports: Partial<Ports> = {}): PluginContext => ({
  config,
  resolveSecret: async (_ref, at) => `secret for ${at}`,
  log: { debug() {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  publicUrl: "https://stardust.example.com",
  region: "test",
  ports,
});

it("provides the source port, and says once that a retired key is ignored", async () => {
  lines.length = 0;
  const ports = await plugin.provides?.create(context({ token: { env: "T" }, webhookSecret: { env: "W" } }));
  assert.equal(typeof ports?.source?.resolveTarget, "function");
  assert.deepEqual(lines, [
    "plugins.source-github.webhookSecret is ignored: webhooks were removed; runs start only when someone asks for one",
  ]);
});

it("with GitHub App credentials, also gives builds a one-time clone token", async () => {
  const ports = await plugin.provides?.create(context({ appId: 1, privateKey: { file: "/k" } }));
  assert.equal(typeof ports?.source?.resolveTarget, "function");
  assert.equal(typeof ports?.source?.cloneToken, "function");
  const withToken = await plugin.provides?.create(context({ token: { env: "T" } }));
  assert.equal(withToken?.source?.cloneToken, undefined, "a static token keeps the static clone secret");
});
