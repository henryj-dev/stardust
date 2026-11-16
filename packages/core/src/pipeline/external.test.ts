import assert from "node:assert/strict";
import { it } from "node:test";
import { buildDecision, digestOf, PINNED_IMAGE, trustOf } from "./external.ts";

const PIN = "a".repeat(40);
const ext = trustOf({ trust: "external", pin: PIN });

it("reads trust from a project's metadata, ignoring a pin that is not a commit", () => {
  assert.deepEqual(trustOf({}), { external: false, pin: null });
  assert.deepEqual(trustOf({ trust: "external", pin: "main" }), { external: true, pin: null });
  assert.deepEqual(ext, { external: true, pin: PIN });
});

it("builds our own code as trusted, and someone else's only mirrored unless the operator allows it", () => {
  assert.deepEqual(buildDecision(trustOf({}), { projectId: "p", pipeline: "C", sha: "b".repeat(40) }, []), {
    ok: true,
    trusted: true,
  });
  assert.deepEqual(buildDecision(ext, { projectId: "p", pipeline: "M", sha: PIN }, []), { ok: true, trusted: false });
  const refused = buildDecision(ext, { projectId: "p", pipeline: "C", sha: PIN }, []);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /jobs\.upstreamBuilds/);
  assert.deepEqual(
    buildDecision(ext, { projectId: "p", pipeline: "N", sha: PIN }, ["p"]),
    { ok: true, trusted: false },
    "allowed, still untrusted",
  );
});

it("runs only the pinned commit", () => {
  const other = buildDecision(ext, { projectId: "p", pipeline: "M", sha: "c".repeat(40) }, ["p"]);
  assert.equal(other.ok, false);
  assert.match(other.ok ? "" : other.reason, /pinned to aaaaaaaaaaaa/);
});

it("accepts only images pinned by digest", () => {
  const d = `sha256:${"e".repeat(64)}`;
  assert.ok(PINNED_IMAGE.test(`docker.io/org/app:2.7.0@${d}`));
  assert.ok(PINNED_IMAGE.test(`ghcr.io/org/app@${d}`));
  assert.ok(!PINNED_IMAGE.test("docker.io/org/app:2.7.0"));
  assert.ok(!PINNED_IMAGE.test(`docker.io/org/app:2.7.0@${d}; id`));
  assert.equal(digestOf(`ghcr.io/org/app@${d}`), d);
});
