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

it("provides the deploy repository with where env lives and the build annotation", async () => {
  const ports = await plugin.provides?.create(
    context({
      url: "https://github.com/acme/deploy",
      branch: "main",
      token: { env: "T" },
      envRoot: "deploy/clusters/a/env",
      buildRevAnnotation: "example.com/build-rev",
    }),
  );
  assert.equal(typeof ports?.deployRepo?.repo.headSha, "function");
  assert.equal(ports?.deployRepo?.envRoot, "deploy/clusters/a/env");
  assert.equal(ports?.deployRepo?.buildRevAnnotation, "example.com/build-rev");
});

it("leaves the env root and annotation unset when not configured", async () => {
  const ports = await plugin.provides?.create(context({ url: "/srv/deploy.git", branch: "main" }));
  assert.equal(ports?.deployRepo?.envRoot, undefined);
  assert.equal(ports?.deployRepo?.buildRevAnnotation, undefined);
});
