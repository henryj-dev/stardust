import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TOKEN_EXPIRY, expiryDaysFrom, TOKEN_EXPIRY_CHOICES, tokenRequestFrom } from "./token-form.ts";

const formOf = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
};

describe("API token expiry", () => {
  it("reads each offered choice; never is null", () => {
    assert.deepEqual(
      TOKEN_EXPIRY_CHOICES.map((c) => expiryDaysFrom(c.value)),
      [1, 7, 30, 90, null],
    );
  });

  it("refuses what the form does not offer", () => {
    for (const v of ["", "0", "2", "30.0", " 30", "3650", "-1", "Never", "null"]) {
      assert.equal(expiryDaysFrom(v), undefined, v);
    }
    assert.equal(expiryDaysFrom(null), undefined);
    assert.equal(expiryDaysFrom(new File([], "x")), undefined);
  });

  it("defaults to one of the choices: 30 days", () => {
    assert.equal(DEFAULT_TOKEN_EXPIRY, "30");
    assert.equal(expiryDaysFrom(DEFAULT_TOKEN_EXPIRY), 30);
  });
});

describe("the new-token form", () => {
  it("trims the name and reads the lifetime", () => {
    assert.deepEqual(tokenRequestFrom(formOf({ name: "  ci  ", expiry: "7" })), {
      ok: true,
      name: "ci",
      expiresInDays: 7,
    });
    assert.deepEqual(tokenRequestFrom(formOf({ name: "cron", expiry: "never" })), {
      ok: true,
      name: "cron",
      expiresInDays: null,
    });
  });

  it("refuses a missing or long name and an unknown lifetime, keeping what was typed", () => {
    assert.deepEqual(tokenRequestFrom(formOf({ name: " ", expiry: "90" })), {
      ok: false,
      error: "Give the token a name.",
      name: "",
      expiry: "90",
    });
    const long = tokenRequestFrom(formOf({ name: "n".repeat(101), expiry: "1" }));
    assert.equal(long.ok, false);
    assert.match(long.ok ? "" : long.error, /at most 100/);
    assert.ok(tokenRequestFrom(formOf({ name: "n".repeat(100), expiry: "1" })).ok);
    assert.deepEqual(tokenRequestFrom(formOf({ name: "ci", expiry: "5" })), {
      ok: false,
      error: "Choose how long the token lasts.",
      name: "ci",
      expiry: "30",
    });
    assert.equal(tokenRequestFrom(formOf({ name: "ci" })).ok, false, "no lifetime given");
  });
});
