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
  ports,
});

it("provides sign-in with the callback under the public URL, and does not contact the provider yet", async () => {
  const ports = await plugin.provides?.create(
    context({
      issuer: "https://id.example.com",
      clientId: "stardust",
      clientSecret: { env: "S" },
      adminGroups: ["platform"],
      autoCreate: true,
    }),
  );
  assert.equal(ports?.identity?.redirectUri, "https://stardust.example.com/login/oidc/callback");
  assert.equal(ports?.identity?.displayName, "single sign-on");
  assert.equal(ports?.identity?.autoCreate, true);
  assert.deepEqual(ports?.identity?.rules, { adminGroups: ["platform"] });
});
