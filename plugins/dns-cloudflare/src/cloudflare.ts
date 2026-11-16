/**
 * DNS on Cloudflare (API v4). Zones are found by name; a record is matched
 * by name and type. The token needs Zone:Read and DNS:Edit, and should be
 * limited to the zones stardust manages.
 */
import {
  type DnsProvider,
  type DnsRecord,
  type DnsRecordType,
  dnsRecordProblems,
  normalizeDnsName,
} from "@stardust/core";

export interface CloudflareOptions {
  token: string;
  apiBaseUrl?: string;
  /** Only these zones are listed and touched; empty means every zone the token sees. */
  zones?: readonly string[];
  fetch?: typeof fetch;
}

interface CfRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied?: boolean;
}

export function cloudflareDns(options: CloudflareOptions): DnsProvider {
  const base = (options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const allowed = new Set((options.zones ?? []).map(normalizeDnsName));
  const zoneIds = new Map<string, string>();

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ result: T; info?: { total_pages?: number } }> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: T;
      result_info?: { total_pages?: number };
      errors?: Array<{ code?: number; message?: string }>;
    } | null;
    if (!res.ok || json?.success === false) {
      const reason = json?.errors?.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");
      const error = new Error(
        `Cloudflare ${method} ${path.split("?")[0]} answered ${res.status}${reason ? `: ${reason}` : ""}`,
      );
      (error as Error & { status?: number }).status = res.status;
      throw error;
    }
    return { result: json?.result as T, ...(json?.result_info ? { info: json.result_info } : {}) };
  }

  async function pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const { result, info } = await call<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...result);
      if (!info?.total_pages || page >= info.total_pages) return out;
    }
  }

  const permitted = (zone: string) => allowed.size === 0 || allowed.has(normalizeDnsName(zone));

  async function zoneId(zone: string): Promise<string> {
    const name = normalizeDnsName(zone);
    if (!permitted(name)) throw new Error(`zone ${name} is not one stardust manages here`);
    const known = zoneIds.get(name);
    if (known) return known;
    const [found] = await call<Array<{ id: string; name: string }>>(
      "GET",
      `/zones?name=${encodeURIComponent(name)}`,
    ).then((r) => r.result);
    if (!found) throw new Error(`Cloudflare has no zone ${name} for this token`);
    zoneIds.set(name, found.id);
    return found.id;
  }

  const toRecord = (r: CfRecord): DnsRecord => ({
    id: r.id,
    name: normalizeDnsName(r.name),
    type: r.type as DnsRecordType,
    content: r.content,
    ttl: r.ttl,
    view: null,
    proxied: r.proxied === true,
  });

  return {
    capabilities: { views: [], proxied: true, asyncApply: false },
    async listZones() {
      const zones = await pages<{ name: string }>("/zones");
      return zones
        .map((z) => normalizeDnsName(z.name))
        .filter(permitted)
        .sort();
    },
    async listRecords(zone, filter = {}) {
      const query = new URLSearchParams();
      if (filter.name) query.set("name", normalizeDnsName(filter.name));
      if (filter.type) query.set("type", filter.type);
      const records = await pages<CfRecord>(`/zones/${await zoneId(zone)}/dns_records${query.size ? `?${query}` : ""}`);
      return records.map(toRecord);
    },
    async upsert(zone, record) {
      const problems = dnsRecordProblems(zone, record);
      if (problems.length > 0) throw new Error(problems.join("; "));
      const id = await zoneId(zone);
      const name = normalizeDnsName(record.name);
      const body = {
        name,
        type: record.type,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied === true,
      };
      const [existing] = await pages<CfRecord>(
        `/zones/${id}/dns_records?${new URLSearchParams({ name, type: record.type })}`,
      );
      const saved = existing
        ? await call<CfRecord>("PUT", `/zones/${id}/dns_records/${encodeURIComponent(existing.id)}`, body)
        : await call<CfRecord>("POST", `/zones/${id}/dns_records`, body);
      return toRecord(saved.result);
    },
    async delete(zone, recordId) {
      try {
        await call("DELETE", `/zones/${await zoneId(zone)}/dns_records/${encodeURIComponent(recordId)}`);
      } catch (err) {
        if ((err as { status?: number }).status === 404) return;
        throw err;
      }
    },
  };
}
