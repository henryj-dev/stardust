import assert from "node:assert/strict";
import { it } from "node:test";
import { ownedElsewhere, ownerRegion } from "./ownership.ts";

it("names the owner of a project owned by another region, and lets an unowned one be changed anywhere", () => {
  assert.equal(ownerRegion({ region: "dev-ams" }), "dev-ams");
  assert.equal(ownerRegion({ region: "Not A Region" }), null);
  assert.equal(ownedElsewhere({ region: "dev-ams" }, "prod-fra"), "dev-ams");
  assert.equal(ownedElsewhere({ region: "prod-fra" }, "prod-fra"), null);
  assert.equal(ownedElsewhere({}, "prod-fra"), null, "from before regions");
  assert.equal(ownedElsewhere({ region: "dev-ams" }, undefined), null, "a server that does not know its region");
});
