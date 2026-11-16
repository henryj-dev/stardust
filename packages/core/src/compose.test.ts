import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssemblyError, assemble } from "./compose.ts";
import type { Logger } from "./logger.ts";
import { definePlugin, type Plugin } from "./plugin.ts";
import type { PortName, Ports } from "./ports/index.ts";

const lines: string[] = [];
const log: Logger = {
  debug() {},
  info: (m) => lines.push(m),
  warn: (m) => lines.push(m),
  error: (m) => lines.push(m),
};

const fakeKube: Ports["kube"] = {
  request: async () => ({ status: 200, body: "" }),
  stream: async () => ({ status: 200, body: (async function* () {})() }),
};
const fakeSource = { resolveTarget: async () => ({ ref: "refs/heads/main", sha: "a".repeat(40) }) };
const fakeBuilder = { build: async () => ({ result: "success" as const, jobName: "j", digest: "d", logTail: "" }) };

/** A plugin that provides `ports` (built from `make`) and counts how often it was built. */
function provider(
  name: string,
  ports: PortName[],
  make: (ctx: { ports: Partial<Ports>; config: Record<string, unknown> }) => Partial<Ports>,
  extra: Partial<Pick<Plugin, "requires">> & { needs?: PortName[] } = {},
) {
  let built = 0;
  const plugin = definePlugin({
    manifest: { name, description: name },
    validateConfig: () => [],
    provides: {
      ports,
      ...(extra.needs ? { needs: extra.needs } : {}),
      async create(ctx) {
        built++;
        return make(ctx);
      },
    },
    ...(extra.requires ? { requires: extra.requires } : {}),
  });
  return { plugin, built: () => built };
}

const run = (plugins: Plugin[], want: PortName[], more: Partial<Parameters<typeof assemble>[0]> = {}) =>
  assemble({
    plugins,
    sections: {},
    want,
    resolveSecret: async () => "secret",
    log,
    publicUrl: "https://stardust.example.com/",
    region: "test",
    ...more,
  });

describe("assemble", () => {
  it("builds the wanted ports, each after the ports it needs, and hands over its section", async () => {
    const seen: Array<Partial<Ports>> = [];
    const builder = provider(
      "builder",
      ["builder"],
      (ctx) => {
        seen.push(ctx.ports);
        assert.equal(ctx.config.namespace, "builds");
        return { builder: fakeBuilder };
      },
      { needs: ["source"] },
    );
    const source = provider("source", ["source"], () => ({ source: fakeSource }));
    const ports = await run([builder.plugin, source.plugin], ["builder"], {
      sections: { builder: { namespace: "builds" } },
    });
    assert.equal(ports.builder, fakeBuilder);
    assert.equal(ports.source, fakeSource, "a needed port is built even when not wanted");
    assert.equal(seen[0]?.source, fakeSource);
  });

  it("does not build what this process does not want, so its secrets are never read", async () => {
    const identity = provider("identity", ["identity"], () => ({}));
    await run([identity.plugin], ["builder"]);
    assert.equal(identity.built(), 0);
  });

  it("platform ports satisfy needs, and the public URL loses its trailing slash", async () => {
    let url = "";
    const builder = definePlugin({
      manifest: { name: "builder", description: "b" },
      validateConfig: () => [],
      provides: {
        ports: ["builder"],
        needs: ["kube"],
        async create(ctx) {
          url = ctx.publicUrl;
          return ctx.ports.kube ? { builder: fakeBuilder } : {};
        },
      },
    });
    const ports = await run([builder], ["builder"], { platform: { kube: fakeKube } });
    assert.equal(ports.builder, fakeBuilder);
    assert.equal(url, "https://stardust.example.com");
  });

  it("leaves a provider off, and says so, when what it needs is not there", async () => {
    lines.length = 0;
    const builder = provider("builder", ["builder"], () => ({ builder: fakeBuilder }), { needs: ["kube"] });
    const ports = await run([builder.plugin], ["builder"]);
    assert.equal(ports.builder, undefined);
    assert.equal(builder.built(), 0);
    assert.ok(
      lines.some((l) => l === "builder is off: it needs kube"),
      lines.join("\n"),
    );
  });

  it("stops start-up naming the plugin and the port when something it requires is missing", async () => {
    const feature = definePlugin({
      manifest: { name: "runtime", description: "r" },
      validateConfig: () => [],
      requires: ["kube", "deployRepo"],
    });
    await assert.rejects(run([feature], []), (err: Error) => {
      assert.ok(err instanceof AssemblyError);
      assert.match(err.message, /runtime requires kube, deployRepo, which no enabled plugin provides/);
      return true;
    });
  });

  it("builds a port a feature uses when it is configured, and starts without it when it is not", async () => {
    const feature = definePlugin({
      manifest: { name: "uses-source", description: "u" },
      validateConfig: () => [],
      uses: ["source"],
    });
    const source = provider("source-a", ["source"], () => ({ source: fakeSource }));
    assert.equal((await run([feature, source.plugin], [])).source, fakeSource, "wanted because the feature uses it");
    assert.equal((await run([feature], [])).source, undefined, "and no error without it");
  });

  it("refuses two plugins providing the same port", async () => {
    const a = provider("source-a", ["source"], () => ({ source: fakeSource }));
    const b = provider("source-b", ["source"], () => ({ source: fakeSource }));
    await assert.rejects(
      run([a.plugin, b.plugin], ["source"]),
      /port source is provided by both source-a and source-b/,
    );
    const c = provider("kube-again", ["kube"], () => ({}));
    await assert.rejects(
      run([c.plugin], ["kube"], { platform: { kube: fakeKube } }),
      /port kube is provided by both stardust itself and kube-again/,
    );
  });

  it("refuses a port the plugin did not declare", async () => {
    const sneaky = provider("sneaky", ["source"], () => ({ source: fakeSource, builder: fakeBuilder }));
    await assert.rejects(run([sneaky.plugin], ["source"]), /sneaky returned port builder, which it does not declare/);
  });

  it("merges a multi port by instance name and refuses the same name twice", async () => {
    const multiPorts = new Set<PortName>(["source"]);
    const a = provider("a", ["source"], () => ({ source: { one: fakeSource } as unknown as Ports["source"] }));
    const b = provider("b", ["source"], () => ({ source: { two: fakeSource } as unknown as Ports["source"] }));
    const ports = await run([a.plugin, b.plugin], ["source"], { multiPorts });
    assert.deepEqual(Object.keys(ports.source as object).sort(), ["one", "two"]);
    const c = provider("c", ["source"], () => ({ source: { one: fakeSource } as unknown as Ports["source"] }));
    await assert.rejects(run([a.plugin, c.plugin], ["source"], { multiPorts }), /c: a second source named "one"/);
  });

  it("refuses a cycle of needs instead of hanging", async () => {
    const a = provider("a", ["source"], () => ({ source: fakeSource }), { needs: ["builder"] });
    const b = provider("b", ["builder"], () => ({ builder: fakeBuilder }), { needs: ["source"] });
    await assert.rejects(run([a.plugin, b.plugin], ["source"]), /a cycle of needs\): a, b/);
  });
});

describe("definePlugin", () => {
  it("refuses a plugin that needs or requires the port it provides", () => {
    const base = { manifest: { name: "x", description: "x" }, validateConfig: () => [] };
    const create = async () => ({});
    assert.throws(
      () => definePlugin({ ...base, provides: { ports: ["source"], needs: ["source"], create } }),
      /needs the port it provides: source/,
    );
    assert.throws(
      () => definePlugin({ ...base, provides: { ports: ["source"], create }, requires: ["source"] }),
      /requires the port it provides: source/,
    );
  });
});
