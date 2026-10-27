import assert from "node:assert/strict";
import { it } from "node:test";
import { ALLOWED_TRANSITIONS, canTransition, isTerminal, JOB_STATUSES, TERMINAL } from "./job-status.ts";

it("terminal states have no way out and every non-terminal state has one", () => {
  for (const status of JOB_STATUSES) {
    assert.equal(ALLOWED_TRANSITIONS[status].length === 0, TERMINAL.has(status), status);
  }
});

it("the misspelling 'canceled' is not a terminal state", () => {
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("canceled"), false);
  assert.equal(isTerminal(undefined), false);
});

it("allows the documented transitions only", () => {
  assert.equal(canTransition("queued", "running"), true);
  assert.equal(canTransition("running", "unknown"), true);
  assert.equal(canTransition("queued", "success"), false);
  assert.equal(canTransition("success", "running"), false);
  assert.equal(canTransition("skipped", "running"), false);
});
