/** The tickets stardust's Vultr plugin signs are the ones this broker accepts, and only those. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { approvalClaims, signApproval } from "@stardust/plugin-cloud-vultr";
import { verifyApproval } from "./policy.ts";

const TARGET = "6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60";

it("accepts a ticket the plugin signed for this instance, and refuses it for another, late, or under another key", () => {
  const now = 1_700_000_000_000;
  const ticket = signApproval(approvalClaims(TARGET, "ada", now), "shared-key");
  const at = Math.floor(now / 1000) + 5;
  assert.equal(verifyApproval(ticket, "shared-key", "instance-destroy", TARGET, at).ok, true);
  assert.equal(
    verifyApproval(ticket, "shared-key", "instance-destroy", "6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f61", at).ok,
    false,
  );
  assert.equal(verifyApproval(ticket, "other-key", "instance-destroy", TARGET, at).ok, false);
  assert.equal(verifyApproval(ticket, "shared-key", "instance-destroy", TARGET, at + 600).ok, false);
});
