import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditFilterFrom, olderLink } from "./audit-filter.ts";

describe("audit filter from the URL", () => {
  it("keeps the fields given, drops empty ones, reads zone-less times as UTC", () => {
    const url = new URL("http://x/admin/audit?actor=alice&action=&since=2026-01-02T03:04&project=demo&other=1");
    assert.deepEqual(auditFilterFrom(url, { project: true }), {
      actor: "alice",
      since: "2026-01-02T03:04Z",
      project: "demo",
    });
  });

  it("a project's page ignores a project field", () => {
    const url = new URL("http://x/projects/a/audit?project=b&action=run");
    assert.deepEqual(auditFilterFrom(url, { project: false }), { action: "run" });
  });

  it("links to older events with the same filter", () => {
    const url = new URL("http://x/admin/audit?actor=alice&before=90");
    assert.equal(olderLink(url, "40"), "/admin/audit?actor=alice&before=40");
    assert.equal(olderLink(url, null), null);
  });
});
