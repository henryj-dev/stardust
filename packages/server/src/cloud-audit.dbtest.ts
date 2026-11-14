/** Cloud audit scans: the window they read, findings kept once, and failures that say so. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type AuditLogSource,
  type AuditRecord,
  buildFeatures,
  createPluginRegistry,
  type Logger,
} from "@stardust/core";
import { databasePort, ensureBootstrapAdmin, migratePlugin, signIn } from "@stardust/db";
import { createTestDb, type TestDb } from "@stardust/db/testing";
import { plugin, scanAll } from "@stardust/plugin-cloud-audit";
import { createApp } from "./app.ts";

const PASSWORD = "correct horse battery";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const AUTOMATION = "a".repeat(32);
let db: TestDb;
let app: ReturnType<typeof createApp>;
let admin: Record<string, string>;
let feature: ReturnType<typeof buildFeatures>[number];
const reads: Array<{ since: Date; before: Date }> = [];
let next: { records: AuditRecord[]; truncated: boolean } | Error = { records: [], truncated: false };
const source: AuditLogSource = {
  async read(since, before) {
    reads.push({ since, before });
    if (next instanceof Error) throw next;
    return next;
  },
};
const record = (id: string, when: string, over: Partial<AuditRecord> = {}): AuditRecord => ({
  id,
  when,
  actionType: "gateway_create",
  actorType: "account_token",
  actorId: AUTOMATION,
  actorEmail: "",
  actorIp: "192.0.2.1",
  interfaceHost: "",
  resourceType: "",
  resourceId: "",
  result: true,
  ...over,
});

before(async () => {
  db = await createTestDb();
  await ensureBootstrapAdmin(db.sql, "admin", PASSWORD);
  const r = await signIn(db.sql, "admin", PASSWORD);
  if (!r.ok) throw new Error("admin");
  admin = { authorization: `Bearer ${r.token}`, "content-type": "application/json" };
  const sections = { "cloud-audit": { automationTokens: { [AUTOMATION]: ["gateway_"] } } };
  const ports = { database: databasePort(db.sql), auditLogs: { cloudflare: source } };
  [feature] = buildFeatures(createPluginRegistry([plugin]).resolve(sections), sections, ports, quiet, "test") as [
    ReturnType<typeof buildFeatures>[number],
  ];
  await migratePlugin({ regional: db.sql, global: db.sql }, "cloud-audit", await feature.migrations());
  app = createApp(
    { version: "t" },
    { sql: db.sql, resolveTarget: async () => ({ ref: "", sha: "" }), features: [feature], log: quiet },
  );
});
after(async () => db.close());

const findings = async () =>
  (await (await app.request("/api/v1/plugins/cloud-audit/findings", { headers: admin })).json()) as {
    findings: Array<{ recordId: string; rule: string }>;
    sources: Array<{ source: string; lastError: string | null; scannedUntil: string | null }>;
  };

describe("cloud audit", () => {
  const t0 = new Date("2026-03-01T12:00:00Z");
  const h = (hours: number) => new Date(t0.getTime() + hours * 3_600_000);

  it("looks back a day the first time, keeps what the rules find, once", async () => {
    next = {
      records: [
        record("ok", "2026-03-01T11:00:00Z"),
        record("out", "2026-03-01T11:10:00Z", { actionType: "access_app_create" }),
        record("stranger", "2026-03-01T11:20:00Z", { actorId: "b".repeat(32) }),
      ],
      truncated: false,
    };
    const [r] = await scanAll(feature.context, t0);
    assert.equal(reads.at(-1)?.since.toISOString(), h(-24).toISOString());
    assert.deepEqual([r?.scanned, r?.found], [3, 3]);
    await scanAll(feature.context, t0);
    const { findings: kept } = await findings();
    assert.deepEqual(kept.map((f) => `${f.recordId}:${f.rule}`).sort(), [
      "out:automation-token-out-of-scope",
      "out:protected-area-change",
      "stranger:unknown-account-token",
    ]);
  });

  it("goes on from where it got to, five minutes back, and from the last record when cut short", async () => {
    next = { records: [], truncated: false };
    await scanAll(feature.context, h(1));
    assert.equal(reads.at(-1)?.since.toISOString(), new Date(t0.getTime() - 5 * 60_000).toISOString());
    next = { records: [record("a", h(1.5).toISOString()), record("b", h(1.6).toISOString())], truncated: true };
    await scanAll(feature.context, h(2));
    assert.equal((await findings()).sources[0]?.scannedUntil, h(1.6).toISOString(), "not the window's end");
    assert.match((await findings()).sources[0]?.lastError ?? "", /next scan goes on/);
  });

  it("records a failed scan without moving on, and scans on request", async () => {
    next = new Error("Cloudflare audit_logs answered 403: Authentication error");
    await scanAll(feature.context, h(3));
    const [state] = (await findings()).sources;
    assert.match(state?.lastError ?? "", /403/);
    assert.equal(state?.scannedUntil, h(1.6).toISOString());
    next = { records: [], truncated: false };
    const res = await app.request("/api/v1/plugins/cloud-audit/scan", { method: "POST", headers: admin });
    assert.equal(res.status, 200);
    assert.equal((await findings()).sources[0]?.lastError, null);
  });
});
