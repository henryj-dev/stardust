import assert from "node:assert/strict";
import { it } from "node:test";
import type { KubeStreamClient, PluginContext, Ports } from "@stardust/core";
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

const section = { namespace: "builds", registry: "registry.example.com", pushSecret: "push" };

it("names images without the Kubernetes API, and builds only with it", async () => {
  const bare = await plugin.provides?.create(context(section));
  assert.equal(bare?.builder, undefined);
  assert.equal(bare?.images?.repository("demo", "api"), "registry.example.com/demo/api");
  const created: unknown[] = [];
  const kube: KubeStreamClient = {
    async request(method, _path, body) {
      if (method === "POST") {
        created.push(body);
        return { status: 201, body: JSON.stringify({ metadata: { name: "b-1" } }) };
      }
      if (_path.includes("/pods?")) return { status: 200, body: JSON.stringify({ items: [] }) };
      return { status: 200, body: JSON.stringify({ status: { failed: 1 } }) };
    },
    stream: () => Promise.reject(new Error("unused")),
  };
  const ports = await plugin.provides?.create(context(section, { kube }));
  const outcome = await ports?.builder?.build(
    { projectId: "demo", repo: "acme/app", sha: "a".repeat(40), component: "api", runId: "r1", jobName: "api" },
    { signal: new AbortController().signal, pollMs: 1 },
  );
  assert.equal(outcome?.result, "failed");
  assert.ok(JSON.stringify(created[0]).includes('"IMAGE","value":"registry.example.com/demo/api:aaaaaaa"'));
  assert.equal(typeof ports?.builder?.logs, "function");
});

it("gives pods a read-only pull login, read when asked for, and checks its shape", async () => {
  assert.equal((await plugin.provides?.create(context(section)))?.images?.pull, undefined);
  const withPull = {
    ...section,
    registry: "registry.example.com:5000/team",
    pull: { username: "puller", password: { env: "P" } },
  };
  const pull = (await plugin.provides?.create(context(withPull)))?.images?.pull;
  assert.equal(pull?.host, "registry.example.com:5000");
  assert.deepEqual(await pull?.login(), {
    username: "puller",
    password: "secret for plugins.builder-buildkit.pull.password",
  });
  assert.deepEqual(plugin.validateConfig?.(withPull), []);
  assert.deepEqual(plugin.validateConfig?.({ ...section, pull: { username: "a b", password: "plain", extra: 1 } }), [
    'pull: unknown key "extra"',
    "pull.username must be a user name",
    "pull.password must be { env: NAME } or { file: PATH }",
  ]);
});
