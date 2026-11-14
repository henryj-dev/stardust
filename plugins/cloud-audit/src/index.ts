/**
 * Cloud audit: reads each provider's audit log on a schedule, runs the
 * detection rules over it, and keeps what they find for administrators.
 *
 *   cloud-audit:
 *     automationTokens:              # your automation tokens by id, and what each may touch
 *       0123abcd…: [gateway_, dns_]
 *     alwaysAlertPrefixes: [access_] # optional: areas never changed through the API (default access_)
 *
 * It scans every 30 minutes. Each scan reads from where the last one ended, five minutes back so
 * nothing at the edge is missed (a finding is kept once per record and
 * rule), and never more than a week back. A scan that fails says so: "it
 * failed" must not look like "it never ran", which is detection silently
 * dead.
 */
import { randomUUID } from "node:crypto";
import {
  type AuditFinding,
  type Database,
  DEFAULT_ALWAYS_ALERT_PREFIXES,
  type DetectionConfig,
  definePlugin,
  detectAll,
  type FeatureContext,
  type Route,
} from "@stardust/core";

const MIGRATION = `
-- What the rules found, once per record and rule.
CREATE TABLE cloud_audit_findings (
  id           uuid PRIMARY KEY,
  source       text NOT NULL,
  record_id    text NOT NULL,
  rule         text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('high', 'medium')),
  reason       text NOT NULL,
  action_type  text NOT NULL,
  actor_type   text NOT NULL,
  actor_id     text NOT NULL,
  actor_email  text NOT NULL,
  actor_ip     text NOT NULL,
  occurred_at  timestamptz,
  found_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, record_id, rule)
);
CREATE INDEX cloud_audit_findings_found_idx ON cloud_audit_findings (found_at DESC);

-- Where each source's scans got to, and how the last one went.
CREATE TABLE cloud_audit_state (
  source        text PRIMARY KEY,
  scanned_until timestamptz,
  last_scan_at  timestamptz,
  last_count    int,
  last_error    text CHECK (length(last_error) <= 1000)
);
`;

const FIRST_LOOKBACK_MS = 24 * 3_600_000;
const MAX_WINDOW_MS = 7 * 24 * 3_600_000;
const OVERLAP_MS = 5 * 60_000;

interface Section {
  automationTokens?: Record<string, string[]>;
  alwaysAlertPrefixes?: string[];
}

const database = (ctx: FeatureContext): Database => {
  if (!ctx.ports.database) throw new Error("cloud-audit needs the database");
  return ctx.ports.database;
};

export function detectionConfig(section: Section): DetectionConfig {
  return {
    automationTokens: section.automationTokens ?? {},
    alwaysAlertPrefixes: section.alwaysAlertPrefixes ?? DEFAULT_ALWAYS_ALERT_PREFIXES,
  };
}

export interface ScanResult {
  source: string;
  ok: boolean;
  scanned: number;
  found: number;
  error?: string;
}

/** One scan of every source: the window, the rules, the findings kept, the state written either way. */
export async function scanAll(ctx: FeatureContext, now = new Date()): Promise<ScanResult[]> {
  const db = database(ctx);
  const config = detectionConfig(ctx.config as Section);
  const results: ScanResult[] = [];
  for (const [source, log] of Object.entries(ctx.ports.auditLogs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const [state] = await db.query<{ scanned_until: Date | null }>(
      "SELECT scanned_until FROM cloud_audit_state WHERE source = $1",
      [source],
    );
    const until = state?.scanned_until ? new Date(state.scanned_until).getTime() : null;
    const since = new Date(
      until === null ? now.getTime() - FIRST_LOOKBACK_MS : Math.max(until - OVERLAP_MS, now.getTime() - MAX_WINDOW_MS),
    );
    try {
      const window = await log.read(since, now);
      let found = 0;
      for (const f of detectAll(window.records, config)) found += await keep(db, source, f);
      // Cut short: go on from the last record read, not from the end of the window.
      const last = window.records.at(-1)?.when;
      const reached = window.truncated && last ? new Date(last) : now;
      await db.query(
        `INSERT INTO cloud_audit_state (source, scanned_until, last_scan_at, last_count, last_error) VALUES ($1, $2, now(), $3, $4)
         ON CONFLICT (source) DO UPDATE SET scanned_until = $2, last_scan_at = now(), last_count = $3, last_error = $4`,
        [
          source,
          reached,
          window.records.length,
          window.truncated ? "more records than one scan reads: the next scan goes on" : null,
        ],
      );
      results.push({ source, ok: true, scanned: window.records.length, found });
    } catch (err) {
      const message = (err as Error).message.slice(0, 1000);
      await db.query(
        `INSERT INTO cloud_audit_state (source, last_scan_at, last_error) VALUES ($1, now(), $2)
         ON CONFLICT (source) DO UPDATE SET last_scan_at = now(), last_error = $2`,
        [source, message],
      );
      ctx.log.warn("a cloud audit scan failed", { source, error: message });
      results.push({ source, ok: false, scanned: 0, found: 0, error: message });
    }
  }
  return results;
}

async function keep(db: Database, source: string, f: AuditFinding): Promise<number> {
  const r = f.record;
  const rows = await db.query(
    `INSERT INTO cloud_audit_findings (id, source, record_id, rule, severity, reason, action_type, actor_type, actor_id, actor_email, actor_ip, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (source, record_id, rule) DO NOTHING RETURNING id`,
    [
      randomUUID(),
      source,
      r.id,
      f.rule,
      f.severity,
      f.reason,
      r.actionType,
      r.actorType,
      r.actorId,
      r.actorEmail,
      r.actorIp,
      r.when || null,
    ],
  );
  return rows.length;
}

function routes(ctx: FeatureContext): Route[] {
  const db = database(ctx);
  return [
    {
      method: "GET",
      path: "/findings",
      permission: "cloud-audit:read",
      async handle({ query }) {
        const limit = Math.min(Math.max(Number(query.get("limit") ?? 100) || 100, 1), 500);
        const [findings, sources] = await Promise.all([
          db.query(
            `SELECT source, record_id AS "recordId", rule, severity, reason, action_type AS "actionType", actor_type AS "actorType",
                    actor_id AS "actorId", actor_email AS "actorEmail", actor_ip AS "actorIp", occurred_at AS "occurredAt", found_at AS "foundAt"
             FROM cloud_audit_findings ORDER BY found_at DESC, severity LIMIT $1`,
            [limit],
          ),
          db.query(
            `SELECT source, scanned_until AS "scannedUntil", last_scan_at AS "lastScanAt", last_count AS "lastCount", last_error AS "lastError"
             FROM cloud_audit_state ORDER BY source`,
          ),
        ]);
        return { status: 200, body: { findings, sources } };
      },
    },
    {
      method: "POST",
      path: "/scan",
      permission: "cloud-audit:write",
      audit: "cloud-audit.scan",
      async handle() {
        const results = await scanAll(ctx);
        return { status: 200, body: { results }, audit: { target: "all", detail: { results } } };
      },
    },
  ];
}

export const plugin = definePlugin({
  manifest: { name: "cloud-audit", description: "Signs of compromise in cloud providers' audit logs." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems = Object.keys(s)
      .filter((k) => !["automationTokens", "alwaysAlertPrefixes"].includes(k))
      .map((k) => `unknown key "${k}"`);
    if (s.automationTokens !== undefined) {
      const t = s.automationTokens as Record<string, unknown>;
      if (typeof t !== "object" || t === null || Array.isArray(t))
        problems.push("automationTokens must map token ids to prefixes");
      else
        for (const [id, prefixes] of Object.entries(t)) {
          if (!/^[0-9a-f]{32}$/.test(id)) problems.push(`automationTokens: ${id.slice(0, 8)}… is not a token id`);
          if (
            !Array.isArray(prefixes) ||
            prefixes.length === 0 ||
            !prefixes.every((p) => typeof p === "string" && p !== "")
          ) {
            problems.push(`automationTokens: ${id.slice(0, 8)}… needs a list of action type prefixes`);
          }
        }
    }
    if (
      s.alwaysAlertPrefixes !== undefined &&
      (!Array.isArray(s.alwaysAlertPrefixes) || !s.alwaysAlertPrefixes.every((p) => typeof p === "string"))
    ) {
      problems.push("alwaysAlertPrefixes must be a list of prefixes");
    }
    return problems;
  },
  requires: ["auditLogs", "database"],
  permissions: [
    { id: "cloud-audit:read", description: "See what the audit rules found", grantedTo: "admins" },
    { id: "cloud-audit:write", description: "Scan now", grantedTo: "admins" },
  ],
  capabilities: ["cloud-audit.findings"],
  migrations: async () => [{ name: "0001_cloud_audit.sql", scope: "regional", sql: MIGRATION }],
  schedules: [{ id: "scan", everyMs: 30 * 60_000, run: async (ctx) => void (await scanAll(ctx)) }],
  routes,
});
