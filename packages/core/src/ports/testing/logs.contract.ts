/** The contract every LogSource keeps, live or history: run against each adapter over a faked transport. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogResult, LogSource } from "../logs.ts";

export interface LogSeed {
  namespace: string;
  pod: string;
  container: string;
  lines: string[];
}

const SEED: LogSeed[] = [
  { namespace: "demo", pod: "api-1", container: "api", lines: ["one", "two", "three"] },
  { namespace: "demo", pod: "api-1", container: "sidecar", lines: ["side"] },
];

async function text(result: LogResult): Promise<string> {
  assert.equal(result.state, "open");
  if (result.state !== "open") return "";
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of result.body) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

export function logSourceContract(name: string, setup: (seed: readonly LogSeed[]) => Promise<LogSource>): void {
  describe(`LogSource contract: ${name}`, () => {
    const signal = new AbortController().signal;
    const base = { namespace: "demo", pod: "api-1", follow: false, signal };

    it("reads one container's lines in order, each ending in a newline", async () => {
      const source = await setup(SEED);
      assert.equal(await text(await source.read({ ...base, container: "api" })), "one\ntwo\nthree\n");
      assert.equal(await text(await source.read({ ...base, container: "sidecar" })), "side\n");
    });

    it("keeps only the last lines when asked", async () => {
      const source = await setup(SEED);
      assert.equal(await text(await source.read({ ...base, container: "api", tailLines: 2 })), "two\nthree\n");
    });

    it("says there is nothing for a pod it does not know", async () => {
      const source = await setup(SEED);
      assert.deepEqual(await source.read({ ...base, pod: "gone-1", container: "api" }), { state: "none" });
    });

    it("refuses names that are not Kubernetes names, before asking anything", async () => {
      const source = await setup(SEED);
      await assert.rejects(source.read({ ...base, pod: 'api-1"} or {x="' }));
      await assert.rejects(source.read({ ...base, namespace: "../kube-system" }));
    });
  });
}
