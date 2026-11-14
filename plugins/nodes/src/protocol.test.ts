import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { livenessOf, MAX_FRAME_BYTES, parseClientMessage } from "./protocol.ts";

// Frames the agent itself writes (agent/testdata/frames); never built here.
const golden = (name: string) =>
  readFileSync(new URL(`../../../agent/testdata/frames/${name}.json`, import.meta.url), "utf8");

it("reads the agent's own frames", () => {
  const hello = parseClientMessage(golden("hello"));
  assert.ok(hello.ok && hello.msg.type === "hello");
  assert.equal(hello.msg.protocolVersion, 1);
  assert.equal(typeof hello.msg.hostProfile.kernel, "string");
  const beat = parseClientMessage(golden("beat"));
  assert.ok(beat.ok && beat.msg.type === "beat");
  assert.equal(beat.msg.seq, 42);
  assert.equal(beat.msg.uptimeS, 987654);
  const metrics = parseClientMessage(golden("metrics"));
  assert.ok(metrics.ok && metrics.msg.type === "metrics");
  assert.deepEqual(metrics.msg.load, [0.42, 0.75, 1.03]);
  assert.equal(metrics.msg.memTotalMb, 16384);
  for (const name of ["hello", "beat", "metrics"]) assert.ok(Buffer.byteLength(golden(name)) <= MAX_FRAME_BYTES);
});

it("refuses what is not a frame", () => {
  for (const [raw, error] of [
    ["{", /invalid json/],
    ["[]", /not an object/],
    ['{"type":"beat","seq":0}', /positive integer/],
    ['{"type":"beat","seq":1,"boot_id":"x"}', /uuid/],
    ['{"type":"shell"}', /unknown type/],
    [`{"type":"hello","x":"${"a".repeat(MAX_FRAME_BYTES)}"}`, /too large/],
  ] as const) {
    const r = parseClientMessage(raw);
    assert.ok(!r.ok);
    assert.match(r.error, error);
  }
});

it("calls a host online, degraded within the reconnect grace, then missing", () => {
  const now = new Date("2026-01-01T00:02:00Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  assert.equal(livenessOf(ago(5), now), "online");
  assert.equal(livenessOf(ago(60), now), "degraded");
  assert.equal(livenessOf(ago(120), now), "missing");
  assert.equal(livenessOf(null, now), "missing");
});
