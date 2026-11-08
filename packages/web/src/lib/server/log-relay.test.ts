import assert from "node:assert/strict";
import { it } from "node:test";
import { relayLog } from "./log-relay.ts";

it("passes the log through as plain text that is never sniffed", async () => {
  const res = await relayLog(new Response("<script>x</script>\n", { headers: { "content-type": "text/html" } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
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
