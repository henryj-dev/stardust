/**
 * Domains: the zones the DNS providers hold, when each expires and with
 * which registrar (RDAP), and their records — read, and changed by an
 * administrator through the zone's provider.
 *
 *   domains:
 *     providers: [cloudflare, parallax]   # optional: the dns ports to read; all by default
 *     rdap: true                          # optional: look up registration data (default true)
 */
import {
  type Database,
  DNS_RECORD_TYPES,
  type DnsProvider,
  type DnsRecordInput,
  definePlugin,
  type FeatureContext,
  normalizeDnsName,
  type Route,
} from "@stardust/core";
import { rdapClient } from "./rdap.ts";

export { rdapClient } from "./rdap.ts";

const MIGRATION = `
-- The zones the DNS providers hold, with registration data from RDAP.
CREATE TABLE domains_zones (
  name            text NOT NULL,
  provider        text NOT NULL,
  registrar       text,
  expires_at      timestamptz,
  nameservers     jsonb NOT NULL DEFAULT '[]',
  rdap_checked_at timestamptz,
  rdap_error      text CHECK (length(rdap_error) <= 500),
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, provider)
);
`;

interface Section {
  providers?: string[];
  rdap?: boolean;
}

interface ZoneRow {
  name: string;
  provider: string;
  registrar: string | null;
  expires_at: Date | null;
  nameservers: string[];
  rdap_checked_at: Date | null;
  rdap_error: string | null;
}

const providersOf = (context: FeatureContext): Array<[string, DnsProvider]> => {
  const all = Object.entries(context.ports.dns ?? {});
  const wanted = (context.config as Section).providers;
  return wanted ? all.filter(([name]) => wanted.includes(name)) : all;
};

const database = (context: FeatureContext): Database => {
  const db = context.ports.globalDatabase ?? context.ports.database;
  if (!db) throw new Error("domains needs the database");
  return db;
};

/** Reads every provider's zones into the table; zones a provider no longer holds are dropped. */
export async function syncZones(context: FeatureContext): Promise<{ zones: number }> {
  const db = database(context);
  let zones = 0;
  for (const [provider, dns] of providersOf(context)) {
    const names = await dns.listZones();
    zones += names.length;
    await db.transaction(async (tx) => {
      for (const name of names) {
        await tx.query(
          `INSERT INTO domains_zones (name, provider) VALUES ($1, $2)
           ON CONFLICT (name, provider) DO UPDATE SET synced_at = now()`,
          [name, provider],
        );
      }
      await tx.query("DELETE FROM domains_zones WHERE provider = $1 AND NOT (name = ANY($2::text[]))", [
        provider,
        names,
      ]);
    });
  }
  return { zones };
}

/** Looks up registration data for every zone (or one), recording errors instead of failing the rest. */
export async function refreshRdap(
  context: FeatureContext,
  only?: string,
  rdap: Pick<ReturnType<typeof rdapClient>, "lookup"> = rdapClient(),
): Promise<number> {
  const db = database(context);
  const rows = await db.query<{ name: string }>(
    only ? "SELECT DISTINCT name FROM domains_zones WHERE name = $1" : "SELECT DISTINCT name FROM domains_zones",
    only ? [only] : [],
  );
  for (const { name } of rows) {
    try {
      const found = await rdap.lookup(name);
      await db.query(
        `UPDATE domains_zones SET registrar = $2, expires_at = $3, nameservers = $4::text::jsonb, rdap_checked_at = now(), rdap_error = NULL
         WHERE name = $1`,
        [name, found?.registrar ?? null, found?.expires ?? null, JSON.stringify(found?.nameservers ?? [])],
      );
    } catch (err) {
      await db.query("UPDATE domains_zones SET rdap_checked_at = now(), rdap_error = $2 WHERE name = $1", [
        name,
        (err as Error).message.slice(0, 500),
      ]);
    }
  }
  return rows.length;
}

const view = (row: ZoneRow) => ({
  name: row.name,
  provider: row.provider,
  registrar: row.registrar,
  expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  daysLeft: row.expires_at ? Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 86_400_000) : null,
  nameservers: row.nameservers,
  rdapCheckedAt: row.rdap_checked_at ? new Date(row.rdap_checked_at).toISOString() : null,
  rdapError: row.rdap_error,
});

function routes(context: FeatureContext): Route[] {
  const db = database(context);
  const zone = async (name: string) => {
    const [row] = await db.query<ZoneRow>("SELECT * FROM domains_zones WHERE name = $1 ORDER BY provider LIMIT 1", [
      normalizeDnsName(name),
    ]);
    const dns = row ? context.ports.dns?.[row.provider] : undefined;
    return row && dns ? { row, dns } : null;
  };
  return [
    {
      method: "GET",
      path: "/domains",
      permission: "domains:read",
      async handle() {
        const rows = await db.query<ZoneRow>("SELECT * FROM domains_zones ORDER BY expires_at NULLS LAST, name");
        return { status: 200, body: { domains: rows.map(view) } };
      },
    },
    {
      method: "POST",
      path: "/domains/sync",
      permission: "domains:write",
      audit: "domains.sync",
      async handle() {
        const synced = await syncZones(context);
        if ((context.config as Section).rdap !== false) await refreshRdap(context);
        return { status: 200, body: synced, audit: { detail: synced } };
      },
    },
    {
      method: "GET",
      path: "/domains/:name",
      permission: "domains:read",
      async handle({ params }) {
        const found = await zone(params.name ?? "");
        if (!found) return { status: 404, body: { error: "unknown domain" } };
        const records = await found.dns.listRecords(found.row.name);
        return {
          status: 200,
          body: { domain: view(found.row), capabilities: found.dns.capabilities, records },
        };
      },
    },
    {
      method: "PUT",
      path: "/domains/:name/records",
      permission: "domains:write",
      audit: "domains.record.set",
      async handle({ params, body }) {
        const found = await zone(params.name ?? "");
        if (!found) return { status: 404, body: { error: "unknown domain" } };
        const b = (body ?? {}) as Partial<DnsRecordInput>;
        if (typeof b.name !== "string" || typeof b.content !== "string" || typeof b.ttl !== "number") {
          return { status: 400, body: { error: "name, type, content and ttl are required" } };
        }
        if (!DNS_RECORD_TYPES.includes(b.type as never)) return { status: 400, body: { error: "unknown record type" } };
        let record: Awaited<ReturnType<DnsProvider["upsert"]>>;
        try {
          record = await found.dns.upsert(found.row.name, {
            name: b.name,
            type: b.type as DnsRecordInput["type"],
            content: b.content,
            ttl: b.ttl,
            ...(b.view ? { view: b.view } : {}),
            ...(b.proxied !== undefined ? { proxied: b.proxied } : {}),
          });
        } catch (err) {
          return { status: 400, body: { error: (err as Error).message } };
        }
        // A provider that publishes later: say whether it is served yet, without failing the write.
        let served = true;
        if (found.dns.capabilities.asyncApply && found.dns.waitApplied) {
          served = await found.dns.waitApplied(found.row.name).then(
            () => true,
            () => false,
          );
        }
        return {
          status: 200,
          body: { record, served },
          audit: {
            target: `${record.name} ${record.type}`,
            detail: { zone: found.row.name, view: record.view, content: record.content },
          },
        };
      },
    },
    {
      method: "DELETE",
      path: "/domains/:name/records/:id",
      permission: "domains:write",
      audit: "domains.record.delete",
      async handle({ params, query }) {
        const found = await zone(params.name ?? "");
        if (!found) return { status: 404, body: { error: "unknown domain" } };
        const v = query.get("view") ?? undefined;
        await found.dns.delete(found.row.name, params.id ?? "", v);
        return {
          status: 200,
          body: { ok: true },
          audit: { target: params.id ?? "", detail: { zone: found.row.name, view: v ?? null } },
        };
      },
    },
  ];
}

export const plugin = definePlugin({
  manifest: { name: "domains", description: "Zones, their registration data and their records." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s)) if (!["providers", "rdap"].includes(key)) problems.push(`unknown key "${key}"`);
    if (
      s.providers !== undefined &&
      (!Array.isArray(s.providers) || !s.providers.every((p) => typeof p === "string"))
    ) {
      problems.push("providers must be a list of dns provider names, e.g. [cloudflare]");
    }
    if (s.rdap !== undefined && typeof s.rdap !== "boolean") problems.push("rdap must be true or false");
    return problems;
  },
  requires: ["dns", "globalDatabase"],
  permissions: [
    { id: "domains:read", description: "See domains, their expiry and records", grantedTo: "admins" },
    { id: "domains:write", description: "Change records and refresh domains", grantedTo: "admins" },
  ],
  capabilities: ["domains.list", "domains.records"],
  migrations: async () => [{ name: "0001_zones.sql", scope: "global", sql: MIGRATION }],
  schedules: [
    { id: "sync", everyMs: 6 * 3_600_000, run: async (ctx) => void (await syncZones(ctx)) },
    {
      id: "rdap",
      everyMs: 24 * 3_600_000,
      run: async (ctx) => {
        if ((ctx.config as Section).rdap !== false) await refreshRdap(ctx);
      },
    },
  ],
  routes,
});
