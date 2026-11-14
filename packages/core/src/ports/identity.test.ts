import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAccess, type Identity } from "./identity.ts";

describe("decideAccess", () => {
  const who = (groups: string[]): Identity => ({
    issuer: "i",
    subject: "s",
    username: "u",
    email: null,
    emailVerified: false,
    name: null,
    groups,
  });
  it("allows everyone without allowedGroups, only members with it; admin groups imply access", () => {
    assert.deepEqual(decideAccess(who([]), {}), { allowed: true, isAdmin: false });
    assert.deepEqual(decideAccess(who(["dev"]), { allowedGroups: ["ops"] }), { allowed: false, isAdmin: false });
    assert.deepEqual(decideAccess(who(["ops"]), { allowedGroups: ["ops"] }), { allowed: true, isAdmin: false });
    assert.deepEqual(decideAccess(who(["root"]), { allowedGroups: ["ops"], adminGroups: ["root"] }), {
      allowed: true,
      isAdmin: true,
    });
  });
});
