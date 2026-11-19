import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assemble, type Logger, type Ports } from "@stardust/core";
import { bundledPlugins } from "./index.ts";

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const byName = (name: string) => {
  const plugin = bundledPlugins.find((p) => p.manifest.name === name);
  assert.ok(plugin, name);
  return plugin;
};
const kube: Ports["kube"] = {
  request: async () => ({ status: 200, body: "" }),
  stream: async () => ({ status: 200, body: (async function* () {})() }),
};

// The real plugins, assembled as the server does: a port that only a feature
// reads is built only when that feature says it uses it.
describe("bundled plugins, assembled", () => {
  it("builds the live log source the pod log page reads when runtime and logs-kube are on", async () => {
    const ports = await assemble({
      plugins: [byName("runtime"), byName("logs-kube")],
      sections: { runtime: {}, "logs-kube": {} },
      want: [],
      platform: { kube, deployRepo: {} as Ports["deployRepo"], projects: {} as Ports["projects"] },
      resolveSecret: async () => "",
      log,
      publicUrl: "http://stardust.test",
      region: "test",
    });
    assert.equal(ports.logs?.kube?.kind, "live");
  });
});
