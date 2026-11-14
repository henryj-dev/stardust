import assert from "node:assert/strict";
import { it } from "node:test";
import { dockerHubRef, latest, rank } from "./tags.ts";

const d = (c: string) => `sha256:${c.repeat(64)}`;

it("ranks versions first, stable over pre-release, then other tags naturally", () => {
  const ranked = rank([
    { name: "latest", digest: d("a") },
    { name: "2.7.0", digest: d("b") },
    { name: "v2.10.1", digest: d("c") },
    { name: "2.11.0-rc1", digest: d("d") },
    { name: "2.9", digest: d("e") },
    { name: "broken", digest: "nope" },
  ]);
  assert.deepEqual(
    ranked.map((c) => c.tag),
    ["2.11.0-rc1", "v2.10.1", "2.9", "2.7.0", "latest"],
  );
  assert.equal(latest(ranked)?.tag, "v2.10.1", "the newest stable release, not the release candidate");
  assert.equal(latest(rank([{ name: "edge", digest: d("f") }]))?.tag, "edge");
});

it("reads Docker Hub references, and nothing else", () => {
  assert.deepEqual(dockerHubRef(`docker.io/org/app:2.7@${d("a")}`), { repo: "org/app", tag: "2.7", digest: d("a") });
  assert.deepEqual(dockerHubRef(`org/app@${d("a")}`), { repo: "org/app", tag: null, digest: d("a") });
  assert.equal(dockerHubRef(`ghcr.io/org/app:1@${d("a")}`), null);
  assert.equal(dockerHubRef("docker.io/org/app:2.7"), null);
});
