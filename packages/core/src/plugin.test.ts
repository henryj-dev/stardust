import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPluginRegistry, definePlugin, type Plugin } from "./plugin.ts";

function fakePlugin(name: string, problems: string[] = []): Plugin {
  return definePlugin({
    manifest: { name, description: `${name} for tests` },
    validateConfig: () => problems,
  });
}

describe("definePlugin", () => {
  it("accepts kebab-case names", () => {
    assert.equal(fakePlugin("source-github").manifest.name, "source-github");
  });

  for (const bad of ["Source", "source_github", "-x", "x-", "1x", ""]) {
    it(`rejects name ${JSON.stringify(bad)}`, () => {
      assert.throws(() => fakePlugin(bad), /invalid plugin name/);
    });
  }
});

describe("createPluginRegistry", () => {
  it("rejects duplicate names", () => {
    assert.throws(() => createPluginRegistry([fakePlugin("a"), fakePlugin("a")]), /duplicate plugin name "a"/);
  });

  it("returns only the plugins named in the configuration", () => {
    const registry = createPluginRegistry([fakePlugin("a"), fakePlugin("b")]);
    assert.deepEqual(
      registry.resolve({ b: {} }).map((p) => p.manifest.name),
      ["b"],
    );
  });

  it("reports every problem at once, prefixed with the config path", () => {
    const registry = createPluginRegistry([fakePlugin("a", ["token is required"])]);
    assert.throws(
      () => registry.resolve({ a: {}, nope: {} }),
      (err: Error) =>
        err.message.includes("plugins.a: token is required") && err.message.includes("plugins.nope: unknown plugin"),
    );
  });
});
