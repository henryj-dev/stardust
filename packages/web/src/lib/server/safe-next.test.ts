import assert from "node:assert/strict";
import { it } from "node:test";
import { safeNext } from "./safe-next.ts";

it("keeps paths on this site, with their query and fragment", () => {
  assert.equal(safeNext("/projects/demo?tab=runs#latest"), "/projects/demo?tab=runs#latest");
  assert.equal(safeNext(null), "/");
});

it("refuses everything a browser could take off the site", () => {
  for (const evil of [
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "evil.example",
    "",
  ]) {
    assert.equal(safeNext(evil), "/", JSON.stringify(evil));
  }
});
