import assert from "node:assert/strict";
import { it } from "node:test";
import { formTarget } from "./pull.ts";

it("an empty value pulls the default branch, whatever the kind", () => {
  assert.deepEqual(formTarget("tag", "  "), {});
  assert.deepEqual(formTarget(null, null), {});
});

it("a value becomes the chosen kind of target; an unknown kind is refused", () => {
  assert.deepEqual(formTarget("branch", " release/1 "), { branch: "release/1" });
  assert.deepEqual(formTarget("tag", "v2.7.0"), { tag: "v2.7.0" });
  assert.deepEqual(formTarget("sha", "a".repeat(40)), { sha: "a".repeat(40) });
  assert.equal(formTarget("ref", "main"), null);
});
