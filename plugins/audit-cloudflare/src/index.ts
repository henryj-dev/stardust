/**
 * The audit log of a Cloudflare account, as an `auditLogs` source.
 *
 *   audit-cloudflare:
 *     accountId: 0123…               # the account whose log to read
 *     token: { env: CF_AUDIT_TOKEN } # a token with Account: Audit Logs: Read
 *
 * It reads the REST v1 log (`/accounts/{id}/audit_logs`), oldest first, 200
 * a page and at most 20 pages a window; past that it says the window was cut
 * short, so the reader goes on from the last record instead of skipping.
 * Records of an unexpected shape pass with empty fields rather than failing
 * the batch: a whole window's detection would be lost otherwise, and the
 * rules report a record without an action type.
 */
import { type AuditLogSource, type AuditRecord, definePlugin } from "@stardust/core";

const API = "https://api.cloudflare.com/client/v4";
const PER_PAGE = 200;
const MAX_PAGES = 20;

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** A REST v1 audit record, normalized. */
export function normalizeV1(raw: unknown): AuditRecord {
  const o = (raw ?? {}) as Record<string, unknown>;
  const action = (o.action ?? {}) as Record<string, unknown>;
  const actor = (o.actor ?? {}) as Record<string, unknown>;
  const resource = (o.resource ?? {}) as Record<string, unknown>;
  const type = str(actor.type);
  return {
    id: str(o.id),
    when: str(o.when),
    actionType: str(action.type),
    actorType: type === "user" || type === "account_token" || type === "system" ? type : "unknown",
    actorId: str(actor.id),
    actorEmail: str(actor.email),
    actorIp: str(actor.ip),
    interfaceHost: str(o.interface),
    resourceType: str(resource.type),
    resourceId: str(resource.id),
    result: action.result !== false,
  };
}

export interface CloudflareAuditOptions {
  accountId: string;
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export function cloudflareAudit(options: CloudflareAuditOptions): AuditLogSource {
  const fetchFn = options.fetch ?? fetch;
  const base = (options.apiBaseUrl ?? API).replace(/\/+$/, "");
  return {
    async read(since, before) {
      const records: AuditRecord[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        // Both bounds are required: without one Cloudflare answers 400.
        const qs = new URLSearchParams({
          since: since.toISOString(),
          before: before.toISOString(),
          direction: "asc",
          per_page: String(PER_PAGE),
          page: String(page),
        });
        const res = await fetchFn(`${base}/accounts/${encodeURIComponent(options.accountId)}/audit_logs?${qs}`, {
          headers: { authorization: `Bearer ${options.token}` },
          signal: AbortSignal.timeout(30_000),
        });
        const body = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          result?: unknown[];
          errors?: Array<{ message?: string }>;
        };
        if (!res.ok || body.success === false) {
          throw new Error(
            `Cloudflare audit_logs answered ${res.status}: ${body.errors?.[0]?.message ?? "no reason given"}`,
          );
        }
        const rows = body.result ?? [];
        records.push(...rows.map(normalizeV1));
        if (rows.length < PER_PAGE) return { records, truncated: false };
      }
      return { records, truncated: true };
    },
  };
}

const isRef = (v: unknown) =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && ("env" in v || "file" in v);

export const plugin = definePlugin({
  manifest: { name: "audit-cloudflare", description: "A Cloudflare account's audit log." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems = Object.keys(s)
      .filter((k) => !["accountId", "token", "apiBaseUrl"].includes(k))
      .map((k) => `unknown key "${k}"`);
    if (typeof s.accountId !== "string" || !/^[0-9a-f]{32}$/.test(s.accountId))
      problems.push("accountId must be a Cloudflare account id");
    if (!isRef(s.token)) problems.push("token must be a reference: { env: NAME } or { file: PATH }");
    if (s.apiBaseUrl !== undefined && (typeof s.apiBaseUrl !== "string" || !/^https:\/\/\S+$/.test(s.apiBaseUrl))) {
      problems.push("apiBaseUrl must be an https URL");
    }
    return problems;
  },
  provides: {
    ports: ["auditLogs"],
    async create({ config, resolveSecret }) {
      const c = config as { accountId: string; token: never; apiBaseUrl?: string };
      return {
        auditLogs: {
          cloudflare: cloudflareAudit({
            accountId: c.accountId,
            token: await resolveSecret(c.token, "plugins.audit-cloudflare.token"),
            ...(c.apiBaseUrl ? { apiBaseUrl: c.apiBaseUrl } : {}),
          }),
        },
      };
    },
  },
});
