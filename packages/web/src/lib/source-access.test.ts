import assert from "node:assert/strict";
import { it } from "node:test";
import { accessNote } from "./source-access.ts";

it("warns when stardust cannot read the repository, or when the App reads every repository", () => {
  assert.equal(accessNote({ repo: "acme/web", readable: "public" }).warn, false);
  assert.equal(accessNote({ repo: "acme/web", readable: "token" }).warn, false);
  assert.equal(accessNote({ repo: "acme/web", readable: "app", installation: "selected" }).warn, false);

  const wide = accessNote({ repo: "acme/web", readable: "app", installation: "all" });
  assert.equal(wide.warn, true);
  assert.match(wide.text, /all of the owner's repositories/);
  const none = accessNote({ repo: "acme/web", readable: "none" });
  assert.equal(none.warn, true);
  assert.match(none.text, /Install the App/);
  const failed = accessNote({ repo: "acme/web", error: "source host: GitHub answered 503" });
  assert.equal(failed.warn, true);
  assert.match(failed.text, /503/);
});
