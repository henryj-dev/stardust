import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LogSeed, logSourceContract } from "@stardust/core/testing";
import { lokiLogs, plugin } from "./index.ts";

/** Loki's query_range over seeded streams; it reads the selector the adapter sends. */
function fakeLoki(seed: readonly LogSeed[], seen: Array<{ url: URL; headers: Headers }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, headers: new Headers(init?.headers) });
    const selector = url.searchParams.get("query") ?? "";
    const labels = Object.fromEntries([...selector.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const limit = Number(url.searchParams.get("limit"));
    const result = seed
      .filter(
        (s) =>
          s.namespace === labels.namespace &&
          s.pod === labels.pod &&
          (!labels.container || s.container === labels.container),
      )
      .map((s) => ({
        stream: { namespace: s.namespace, pod: s.pod, container: s.container },
        // Newest first, as direction=backward answers.
        values: s.lines
          .map((line, i) => [String(1_000_000_000n + BigInt(i)), line] as [string, string])
          .reverse()
          .slice(0, limit),
      }));
    return Response.json({ status: "success", data: { resultType: "streams", result } });
  }) as typeof fetch;
}

logSourceContract("logs-loki", async (seed) => lokiLogs({ url: "https://loki.test", fetch: fakeLoki(seed) }));

describe("logs-loki", () => {
  it("asks with the collector's label names, its token and tenant", async () => {
    const seen: Array<{ url: URL; headers: Headers }> = [];
    const source = lokiLogs({
      url: "https://loki.test/",
      token: "secret-token",
      tenant: "team-a",
      labels: { pod: "pod_name" },
      fetch: fakeLoki([], seen),
    });
    await source.read({
      namespace: "demo",
      pod: "api-1",
      container: "api",
      follow: false,
      signal: new AbortController().signal,
    });
    assert.equal(seen[0]?.url.pathname, "/loki/api/v1/query_range");
    assert.equal(seen[0]?.url.searchParams.get("query"), '{namespace="demo",pod_name="api-1",container="api"}');
    assert.equal(seen[0]?.headers.get("authorization"), "Bearer secret-token");
    assert.equal(seen[0]?.headers.get("x-scope-orgid"), "team-a");
  });

  it("validates its section", () => {
    assert.deepEqual(plugin.validateConfig({ url: "https://loki.example.com" }), []);
    assert.deepEqual(
      plugin.validateConfig({ url: "ftp://x", token: "plain", labels: { pod: "pod-name", extra: "x" } }),
      [
        "url must be an http(s) URL",
        "token must be a reference: { env: NAME } or { file: PATH }",
        "labels.pod must be a Loki label name",
        'labels: unknown key "extra"',
      ],
    );
  });
});
