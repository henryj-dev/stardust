import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plugin } from "./index.ts";
import { s3Store, signV4 } from "./s3.ts";

describe("Signature V4", () => {
  it("matches AWS's published test vector (get-vanilla)", () => {
    // From the AWS Signature Version 4 test suite.
    const signature = signV4({
      method: "GET",
      path: "/",
      query: "",
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      amzDate: "20150830T123600Z",
      region: "us-east-1",
      service: "service",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    });
    assert.equal(signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });
});

describe("store-s3", () => {
  it("signs path-style requests with SigV4 and keeps the prefix out of the keys it lists", async () => {
    const seen: Array<{ url: string; method: string; headers: Headers }> = [];
    const store = s3Store({
      endpoint: "https://s3.example.com",
      bucket: "logs",
      region: "auto",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      prefix: "stardust/",
      now: () => new Date("2026-11-15T01:02:03Z"),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
        if (String(input).includes("list-type=2"))
          return new Response(
            "<ListBucketResult><Key>stardust/a/b.log</Key><IsTruncated>false</IsTruncated></ListBucketResult>",
          );
        return new Response("", { status: 200 });
      }) as typeof fetch,
    });
    await store.put("a/b.log", new TextEncoder().encode("x"), "text/plain");
    assert.equal(seen[0]?.url, "https://s3.example.com/logs/stardust/a/b.log");
    const auth = seen[0]?.headers.get("authorization") ?? "";
    assert.match(
      auth,
      /^AWS4-HMAC-SHA256 Credential=AKID\/20261115\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    assert.equal(seen[0]?.headers.get("x-amz-date"), "20261115T010203Z");
    assert.deepEqual(await store.list("a/"), ["a/b.log"]);
    assert.match(seen[1]?.url ?? "", /\/logs\/\?list-type=2&prefix=stardust%2Fa%2F$/);
  });

  it("refuses keys that could leave their place", async () => {
    const store = s3Store({
      endpoint: "https://s3.example.com",
      bucket: "logs",
      region: "auto",
      accessKeyId: "a",
      secretAccessKey: "s",
    });
    for (const key of ["../etc", "/abs", "a/../b", "a b"]) await assert.rejects(store.get(key), /not an object key/);
  });

  it("validates its section; credentials are references only", () => {
    const ok = {
      endpoint: "https://s3.example.com",
      bucket: "stardust-logs",
      region: "auto",
      accessKeyId: { env: "K" },
      secretAccessKey: { env: "S" },
    };
    assert.deepEqual(plugin.validateConfig(ok), []);
    assert.deepEqual(plugin.validateConfig({ ...ok, secretAccessKey: "plain", prefix: "logs" }), [
      "secretAccessKey must be a reference: { env: NAME } or { file: PATH }",
      'prefix must be a key path ending in "/", like build-logs/',
    ]);
  });
});
