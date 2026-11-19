import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import { setResponse } from "@sveltejs/kit/node";
import { logEventTexts } from "../run-log.ts";
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

it("sends a followed log's headers at once through SvelteKit's Node adapter, before it prints anything", async () => {
  // A followed log that has printed nothing yet: the body stays open and empty.
  let close = () => {};
  const quiet = new ReadableStream<Uint8Array>({
    start(c) {
      close = () => c.close();
    },
  });
  const server = createServer((_req, res) => {
    void relayLog(new Response(quiet), { follow: true }).then((response) => setResponse(res, response));
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

/** A body that hands out these byte chunks, then ends (or breaks off). */
function chunks(parts: Uint8Array[], breakOff = false) {
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const next = parts.shift();
      if (next) c.enqueue(next);
      else if (breakOff) c.error(new Error("cluster went away"));
      else c.close();
    },
  });
}

it("sends a followed log as events: the text kept exactly, a character split across chunks whole, then end", async () => {
  const bytes = new TextEncoder().encode('line 1\n한글 줄\n"quoted" \\ tab\t\n');
  const cut = bytes.indexOf(0xed) + 1; // inside the first Hangul character
  const res = await relayLog(new Response(chunks([bytes.slice(0, cut), bytes.slice(cut)])), { follow: true });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const raw = await res.text();
  assert.ok(raw.startsWith(": heartbeat\n\n"), "a heartbeat first, so the headers go out at once");
  assert.ok(raw.trimEnd().endsWith("event: end\ndata: {}"));
  const texts: string[] = [];
  for await (const t of logEventTexts(new Response(raw).body as ReadableStream<Uint8Array>)) texts.push(t);
  assert.equal(texts.join(""), 'line 1\n한글 줄\n"quoted" \\ tab\t\n');
});

it("sends a heartbeat every few seconds while a followed log is quiet", async () => {
  let close = () => {};
  const quiet = new ReadableStream<Uint8Array>({
    start(c) {
      close = () => c.close();
    },
  });
  const res = await relayLog(new Response(quiet), { follow: true, heartbeatMs: 20 });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const until = Date.now() + 110;
  while (Date.now() < until) {
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), until - Date.now())),
    ]);
    if (next && !next.done) seen += decoder.decode(next.value, { stream: true });
  }
  close();
  await reader.cancel();
  const beats = seen.split(": heartbeat\n\n").length - 1;
  assert.ok(beats >= 4, `the first at once and one every 20 ms, saw ${beats}`);
  assert.ok(!seen.includes("event: log"), "nothing printed, so no log events");
});

it("ends a followed log with the reason when the API's stream breaks off", async () => {
  const res = await relayLog(new Response(chunks([new TextEncoder().encode("half\n")], true)), { follow: true });
  const raw = await res.text();
  assert.match(raw, /event: log\ndata: "half\\n"/);
  assert.match(raw, /event: end\ndata: \{"error":"the log stream broke off"\}/);
});

it("keeps a log read once as plain text", async () => {
  const res = await relayLog(new Response("done\n"));
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await res.text(), "done\n");
});
