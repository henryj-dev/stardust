import assert from "node:assert/strict";
import { it } from "node:test";
import { suggestedDir } from "./deploy-dir.ts";

it("suggests a directory once the project and component are named", () => {
  const t = "deploy/apps/{project}/{component}";
  assert.equal(suggestedDir(t, "pico", "push"), "deploy/apps/pico/push");
  assert.equal(suggestedDir(t, "", "push"), "");
  assert.equal(suggestedDir(t, "pico", ""), "");
  assert.equal(suggestedDir(null, "pico", "push"), "");
});
