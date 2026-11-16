import assert from "node:assert/strict";
import { it } from "node:test";
import { pullTarget } from "./app.ts";

const OLD = "a".repeat(40);

it("parses a manual run's target, or says what is wrong with it", () => {
  assert.deepEqual(pullTarget({}), {});
  assert.deepEqual(pullTarget({ branch: "release/1.2" }), { branch: "release/1.2" });
  assert.deepEqual(pullTarget({ tag: "v2.7.0" }), { tag: "v2.7.0" });
  assert.deepEqual(pullTarget({ sha: OLD }), { sha: OLD });
  for (const bad of [
    { branch: "a", tag: "b" },
    { ref: "main" },
    { sha: "abc" },
    { sha: OLD.toUpperCase() },
    { branch: "../etc" },
    { branch: "a..b" },
    { branch: "-rf" },
    { branch: "/x" },
    { branch: "x/" },
    { branch: "a//b" },
    { tag: "v1 " },
    { tag: "v1\n" },
    { tag: "" },
    { branch: 1 },
  ]) {
    assert.equal(typeof pullTarget(bad as Record<string, unknown>), "string", JSON.stringify(bad));
  }
});
