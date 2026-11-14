import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubeStreamClient } from "@stardust/core";
import { type LogSeed, logSourceContract } from "@stardust/core/testing";
import { kubeLogs, plugin } from "./index.ts";

/** The pod log endpoint as the API server answers it, over seeded pods. */
function fakeKube(seed: readonly LogSeed[]): KubeStreamClient {
  return {
    request: () => Promise.reject(new Error("unused")),
    async stream(path) {
      const url = new URL(path, "https://kube.test");
      const m = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/.exec(url.pathname);
      const found = seed.find(
        (s) =>
          m &&
          s.namespace === decodeURIComponent(m[1] ?? "") &&
          s.pod === decodeURIComponent(m[2] ?? "") &&
          s.container === url.searchParams.get("container"),
      );
      if (!found) return { status: 404, body: (async function* () {})() };
      const tail = Number(url.searchParams.get("tailLines") ?? found.lines.length);
      const text = found.lines
        .slice(-tail)
        .map((l) => `${l}\n`)
        .join("");
      return {
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(text);
        })(),
      };
    },
  };
}

logSourceContract("logs-kube", async (seed) => kubeLogs(fakeKube(seed)));

describe("logs-kube", () => {
  it("is the live source named kube, and needs the Kubernetes API", async () => {
    assert.deepEqual(plugin.provides?.needs, ["kube"]);
    const ports = await plugin.provides?.create({
      config: {},
      resolveSecret: async () => "",
      log: { debug() {}, info() {}, warn() {}, error() {} },
      publicUrl: "https://x",
      region: "test",
      ports: { kube: fakeKube([]) },
    });
    assert.equal(ports?.logs?.kube?.kind, "live");
  });
});
