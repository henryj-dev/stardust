import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowReveal, checkApproval, isProtected, issueApproval } from "./guard.ts";
import { MemoryGuardStore } from "./testing.ts";

const KEY = "k".repeat(32);
const claim = { action: "instances.destroy", target: "i-123" };

describe("approval tickets", () => {
  it("approve one action on one target, once", async () => {
    const store = new MemoryGuardStore();
    const ticket = issueApproval(KEY, claim, 300_000);
    const first = await checkApproval(KEY, ticket, claim, store);
    assert.equal(first.ok, true);
    assert.deepEqual(await checkApproval(KEY, ticket, claim, store), { ok: false, reason: "used" });
  });

  it("refuse another target or action, an expired ticket, a forged one and garbage", async () => {
    const store = new MemoryGuardStore();
    const ticket = issueApproval(KEY, claim, 300_000);
    assert.deepEqual(await checkApproval(KEY, ticket, { ...claim, target: "i-999" }, store), {
      ok: false,
      reason: "mismatch",
    });
    assert.deepEqual(await checkApproval(KEY, ticket, { ...claim, action: "instances.resize" }, store), {
      ok: false,
      reason: "mismatch",
    });
    const old = issueApproval(KEY, claim, 1_000, new Date(Date.now() - 10_000));
    assert.deepEqual(await checkApproval(KEY, old, claim, store), { ok: false, reason: "expired" });
    assert.deepEqual(await checkApproval("x".repeat(32), ticket, claim, store), { ok: false, reason: "signature" });
    const [payload, signature] = ticket.split(".");
    const widened = Buffer.from(JSON.stringify({ a: claim.action, t: "*", exp: Date.now() + 1e9, jti: "j" }));
    assert.deepEqual(await checkApproval(KEY, `${widened.toString("base64url")}.${signature}`, claim, store), {
      ok: false,
      reason: "signature",
    });
    assert.deepEqual(await checkApproval(KEY, `${payload}`, claim, store), { ok: false, reason: "malformed" });
    assert.equal((await checkApproval(KEY, ticket, claim, store)).ok, true, "the refusals did not use it up");
  });

  it("need a key long enough to resist guessing", () => {
    assert.throws(() => issueApproval("short", claim, 1_000), /at least 32 characters/);
  });
});

describe("protected targets", () => {
  it("match a prefix or an exact name, ignoring case", () => {
    const rules = { prefixes: ["gateway-", "db-"], exact: ["192.0.2.1"] };
    assert.equal(isProtected("Gateway-east", rules), true);
    assert.equal(isProtected("db-primary", rules), true);
    assert.equal(isProtected("192.0.2.1", rules), true);
    assert.equal(isProtected("web-east", rules), false);
    assert.equal(isProtected("my-gateway-east", rules), false);
    assert.equal(isProtected("anything", {}), false);
  });
});

describe("reveals", () => {
  it("are allowed up to the rule per person per minute", async () => {
    const store = new MemoryGuardStore();
    let now = 1_000_000;
    store.now = () => now;
    const rule = { perMinute: 2 };
    assert.deepEqual(
      [
        await allowReveal(store, "u1", rule),
        await allowReveal(store, "u1", rule),
        await allowReveal(store, "u1", rule),
      ],
      [true, true, false],
    );
    assert.equal(await allowReveal(store, "u2", rule), true, "per person");
    now += 61_000;
    assert.equal(await allowReveal(store, "u1", rule), true, "the window moves");
  });
});
