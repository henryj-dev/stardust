import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { AuditError, listAudit, purgeAudit, recordAudit } from "./audit.ts";
import { createTestDb, type TestDb } from "./testing.ts";

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => db.close());

const alice = { kind: "user", userId: null, name: "alice" } as const;

describe("audit log", () => {
  it("lists newest first, filters by actor, action prefix and project, and pages with a cursor", async () => {
    await recordAudit(db.sql, { actor: alice, action: "project.create", projectId: "p1", target: "p1" });
    await recordAudit(db.sql, {
      actor: alice,
      action: "project.member.set",
      projectId: "p1",
      detail: { role: "viewer" },
    });
    await recordAudit(db.sql, { actor: { ...alice, name: "bob" }, action: "run.start", projectId: "p2" });
    await recordAudit(db.sql, { actor: alice, action: "projectx.other" });

    const all = await listAudit(db.sql);
    assert.deepEqual(
      all.events.map((e) => e.action),
      ["projectx.other", "run.start", "project.member.set", "project.create"],
    );
    assert.deepEqual(all.events[2]?.detail, { role: "viewer" });

    // A prefix matches at a dot only: "project" is not "projectx".
    const project = await listAudit(db.sql, { action: "project" });
    assert.deepEqual(
      project.events.map((e) => e.action),
      ["project.member.set", "project.create"],
    );
    assert.equal((await listAudit(db.sql, { actor: "bob" })).events.length, 1);
    assert.equal((await listAudit(db.sql, { projectId: "p1" })).events.length, 2);

    const first = await listAudit(db.sql, { limit: 3 });
    assert.equal(first.events.length, 3);
    assert.ok(first.next);
    const second = await listAudit(db.sql, { limit: 3, before: first.next });
    assert.deepEqual(
      second.events.map((e) => e.action),
      ["project.create"],
    );
    assert.equal(second.next, null);
  });

  it("orders by number past ten events, not as text", async () => {
    for (let i = 0; i < 12; i++) await recordAudit(db.sql, { actor: alice, action: "order.check", target: String(i) });
    const { events } = await listAudit(db.sql, { action: "order" });
    assert.deepEqual(
      events.map((e) => e.target),
      ["11", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "0"],
    );
  });

  it("filters by time", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await listAudit(db.sql, { since: future })).events.length, 0);
    assert.ok((await listAudit(db.sql, { until: future })).events.length > 0);
  });

  it("refuses an action that is not a dotted name", async () => {
    await assert.rejects(recordAudit(db.sql, { actor: alice, action: "Login" }), AuditError);
    await assert.rejects(recordAudit(db.sql, { actor: alice, action: "login" }), AuditError);
  });

  it("refuses a detail that would carry a credential, at any depth", async () => {
    for (const detail of [
      { password: "x" },
      { secret: "x" },
      { nested: { token: "x" } },
      { list: [{ value: "x" }] },
      { privateKey: "x" },
    ]) {
      await assert.rejects(
        recordAudit(db.sql, { actor: alice, action: "env.set", detail }),
        AuditError,
        JSON.stringify(detail),
      );
    }
    // Names of things are fine.
    await recordAudit(db.sql, { actor: alice, action: "env.set", detail: { keys: ["API_TOKEN"], withPassword: true } });
  });

  it("never changes an event: an UPDATE is refused by the database", async () => {
    await assert.rejects(db.sql`UPDATE audit_events SET actor_name = 'mallory'`, /never changed/);
  });

  it("removes events older than the retention, and keeps everything with 0", async () => {
    await db.sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`;
    await db.sql`INSERT INTO audit_events (actor_kind, actor_name, action, at) VALUES ('system', 'test', 'old.event', now() - interval '40 days')`;
    await db.sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`;
    assert.equal(await purgeAudit(db.sql, 0), 0);
    assert.equal((await listAudit(db.sql, { action: "old" })).events.length, 1);
    assert.equal(await purgeAudit(db.sql, 30), 1);
    assert.equal((await listAudit(db.sql, { action: "old" })).events.length, 0);
    assert.ok((await listAudit(db.sql)).events.length > 0, "recent events stay");
  });
});
