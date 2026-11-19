import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { setResponse } from "@sveltejs/kit/node";
import { relayLog } from "./log-relay.ts";

it("passes the log through as plain text that is never sniffed", async () => {
  const res = await relayLog(new Response("<script>x</script>\n", { headers: { "content-type": "text/html" } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-accel-buffering"), "no", "an nginx in front streams it as it comes");
  assert.equal(await res.text(), "<script>x</script>\n");
});

it("keeps the API's status and reason, and only the reason", async () => {
  const gone = await relayLog(Response.json({ error: "no longer available", extra: "x" }, { status: 410 }));
  assert.equal(gone.status, 410);
  assert.deepEqual(await gone.json(), { error: "no longer available" });
  const odd = await relayLog(new Response("upstream html", { status: 503 }));
  assert.equal(odd.status, 503);
  assert.deepEqual(await odd.json(), { error: "the log could not be read (503)" });
});

it("sends the headers at once through SvelteKit's Node adapter, before the log prints anything", async () => {
  // A followed log that has printed nothing yet: the body stays open and empty.
  let close = () => {};
  const quiet = new ReadableStream<Uint8Array>({
    start(c) {
      close = () => c.close();
    },
  });
  const server = createServer((_req, res) => {
    void relayLog(new Response(quiet)).then((response) => setResponse(res, response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    const status = await new Promise<number>((resolve, reject) => {
      const req = get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      req.on("error", reject);
      setTimeout(() => reject(new Error("no headers within 2s")), 2000).unref();
    });
    assert.equal(status, 200);
    assert.ok(Date.now() - started < 2000);
  } finally {
    close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
