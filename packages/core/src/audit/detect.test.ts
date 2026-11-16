import assert from "node:assert/strict";
import { it } from "node:test";
import { type AuditRecord, DEFAULT_ALWAYS_ALERT_PREFIXES, detect, detectAll } from "./detect.ts";

const AUTOMATION = "a".repeat(32);
const config = {
  automationTokens: { [AUTOMATION]: ["gateway_", "dns_"] },
  alwaysAlertPrefixes: DEFAULT_ALWAYS_ALERT_PREFIXES,
};
const record = (over: Partial<AuditRecord>): AuditRecord => ({
  id: "r1",
  when: "2026-01-01T00:00:00Z",
  actionType: "gateway_create",
  actorType: "account_token",
  actorId: AUTOMATION,
  actorEmail: "",
  actorIp: "192.0.2.1",
  interfaceHost: "api.example.com",
  resourceType: "gateway",
  resourceId: "x",
  result: true,
  ...over,
});
const rules = (r: AuditRecord) => detect(r, config).map((f) => f.rule);

it("is quiet about an automation token doing what it is for", () => {
  assert.deepEqual(rules(record({})), []);
  assert.deepEqual(rules(record({ actionType: "dns_record_update" })), []);
});

it("reports a token out of its scope, an unknown token, and any change to a protected area", () => {
  assert.deepEqual(rules(record({ actionType: "worker_script_update" })), ["automation-token-out-of-scope"]);
  assert.deepEqual(rules(record({ actorId: "b".repeat(32) })), ["unknown-account-token"]);
  assert.deepEqual(rules(record({ actionType: "access_app_create" })), [
    "automation-token-out-of-scope",
    "protected-area-change",
  ]);
  assert.deepEqual(rules(record({ actorType: "user", actorId: "u1", actionType: "access_app_update" })), [
    "protected-area-change",
  ]);
});

it("reports failed attempts and records it cannot classify", () => {
  assert.deepEqual(rules(record({ result: false })), ["failed-attempt"]);
  assert.deepEqual(rules(record({ actorType: "user", actionType: "" })), ["unclassifiable-record"]);
});

it("orders a batch high first, then newest first", () => {
  const found = detectAll(
    [
      record({ id: "old", when: "2026-01-01T00:00:00Z", actorId: "c".repeat(32) }),
      record({ id: "new", when: "2026-01-02T00:00:00Z", actorId: "c".repeat(32) }),
      record({ id: "high", when: "2025-12-01T00:00:00Z", actionType: "access_x" }),
    ],
    config,
  );
  assert.deepEqual(
    found.map((f) => `${f.record.id}:${f.rule}`),
    [
      "high:automation-token-out-of-scope",
      "high:protected-area-change",
      "new:unknown-account-token",
      "old:unknown-account-token",
    ],
  );
});
