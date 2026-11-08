import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { followLog, type LogState } from "./run-log.ts";
import { duration, jobFacts, keptLogTail } from "./run-view.ts";

const json = (status: number, error: string) => Response.json({ error }, { status });

function harness(responses: Array<Response | Error>, active: () => boolean) {
  const urls: string[] = [];
  const states: string[] = [];
  let text = "";
  const run = followLog({
    url: "/log",
    active,
    onReset: () => {
      text = "";
    },
    onText: (t) => {
      text += t;
    },
    onState: (s: LogState) => states.push(s.kind),
    signal: new AbortController().signal,
    retryMs: 1,
    fetch: async (url) => {
      urls.push(String(url));
      const next = responses.shift() ?? json(410, "gone");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { run, urls, states, text: () => text };
}

describe("followLog", () => {
  it("waits while the build has not started, then follows it to the end", async () => {
    let running = true;
    // The job finishes as its log ends.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          c.enqueue(new TextEncoder().encode("#1 a\n"));
          c.enqueue(new TextEncoder().encode("#2 b\n"));
          running = false;
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const h = harness([json(409, "not yet"), new Response(body)], () => running);
    await h.run;
    assert.deepEqual(h.urls, ["/log?follow=true", "/log?follow=true"]);
    assert.deepEqual(h.states, ["connecting", "waiting", "streaming", "ended"]);
    assert.equal(h.text(), "#1 a\n#2 b\n");
  });

  it("reads a finished job's log once, without following", async () => {
    const h = harness([new Response("done\n")], () => false);
    await h.run;
    assert.deepEqual(h.urls, ["/log"]);
    assert.equal(h.text(), "done\n");
    assert.deepEqual(h.states, ["connecting", "streaming", "ended"]);
  });

  it("a reconnect replaces the log instead of repeating it", async () => {
    let calls = 0;
    const h = harness([new Response("a\n"), new Response("a\nb\n")], () => calls++ < 2);
    await h.run;
    assert.equal(h.text(), "a\nb\n");
  });

  it("stops on a log that is gone or refused, with the server's reason", async () => {
    const gone = harness([json(410, "cleaned up")], () => false);
    await gone.run;
    assert.deepEqual(gone.states, ["connecting", "gone"]);
    const denied = harness([json(404, "unknown run")], () => true);
    await denied.run;
    assert.deepEqual(denied.states, ["connecting", "error"]);
  });

  it("retries when the dashboard cannot be reached", async () => {
    const h = harness([new Error("offline"), new Response("x")], () => false);
    await h.run;
    assert.deepEqual(h.states, ["connecting", "error", "streaming", "ended"]);
  });

  it("aborting stops it", async () => {
    const stop = new AbortController();
    stop.abort();
    let fetched = false;
    await followLog({
      url: "/log",
      active: () => true,
      onReset() {},
      onText() {},
      onState() {},
      signal: stop.signal,
      fetch: async () => {
        fetched = true;
        return new Response("");
      },
    });
    assert.equal(fetched, false);
  });
});

describe("run view", () => {
  it("formats durations, and has none before the start", () => {
    assert.equal(duration(null, null), null);
    assert.equal(duration("2026-01-01T00:00:00Z", "2026-01-01T00:00:09Z"), "9s");
    assert.equal(duration("2026-01-01T00:00:00Z", "2026-01-01T00:01:39Z"), "1m 39s");
    assert.equal(duration("2026-01-01T00:00:00Z", null, Date.parse("2026-01-01T02:05:00Z")), "2h 5m");
  });
  it("shows the detail's known fields in order, and the kept log tail apart", () => {
    const detail = { buildJob: "build-1", reason: "deploy repository: no manifest", digest: "", logTail: "tail", x: 1 };
    assert.deepEqual(
      jobFacts(detail).map((f) => f.key),
      ["reason", "buildJob"],
    );
    assert.equal(keptLogTail(detail), "tail");
    assert.equal(keptLogTail({}), null);
  });
});
