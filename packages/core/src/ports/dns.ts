/**
 * DNS: zones and records at a provider. Names are fully qualified, lower
 * case, without the trailing dot, everywhere in stardust; an adapter turns
 * them into what its provider wants (relative names, `@`). What differs
 * between providers is said in `capabilities`, not in more operations.
 */

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA", "NS"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export interface DnsRecord {
  /** The provider's id, unique within the zone (and view). */
  id: string;
  name: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  /** The view it is in, for a provider with views (split horizon); null otherwise. */
  view: string | null;
  proxied?: boolean;
}

export interface DnsRecordInput {
  name: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  view?: string;
  proxied?: boolean;
}

export interface DnsCapabilities {
  /** Views a record can be in (e.g. internal, external); empty for one public view. */
  views: readonly string[];
  /** Records can be served through the provider's proxy. */
  proxied: boolean;
  /** A write is stored first and served later; `waitApplied` waits for it. */
  asyncApply: boolean;
}

export interface DnsProvider {
  readonly capabilities: DnsCapabilities;
  /** Zone names this provider holds (fully qualified). */
  listZones(): Promise<string[]>;
  listRecords(zone: string, filter?: { name?: string; type?: DnsRecordType; view?: string }): Promise<DnsRecord[]>;
  /** Creates the record with this name and type (in this view), or replaces it when there is one. */
  upsert(zone: string, record: DnsRecordInput): Promise<DnsRecord>;
  /** Removes a record. One that is not there is not an error, so a retried delete finishes. */
  delete(zone: string, id: string, view?: string): Promise<void>;
  /** Waits until what was written is served (providers with `asyncApply`). */
  waitApplied?(zone: string): Promise<void>;
}

/** `Api.Example.COM.` → `api.example.com`. */
export function normalizeDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, "");
}

const LABEL = /^(\*|[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)$/;

/** Problems with a record for a zone: a name outside the zone, a bad label, a type or TTL out of range. */
export function dnsRecordProblems(zone: string, r: DnsRecordInput): string[] {
  const problems: string[] = [];
  const z = normalizeDnsName(zone);
  const name = normalizeDnsName(r.name);
  if (name !== z && !name.endsWith(`.${z}`)) problems.push(`${r.name} is not in the zone ${zone}`);
  if (!name.split(".").every((l) => LABEL.test(l))) problems.push(`${r.name} is not a valid name`);
  if (!DNS_RECORD_TYPES.includes(r.type)) problems.push(`record type ${r.type} is not supported`);
  if (!Number.isInteger(r.ttl) || r.ttl < 1 || r.ttl > 86_400) problems.push("ttl must be 1 to 86400 seconds");
  if (typeof r.content !== "string" || r.content === "" || r.content.length > 2048 || /[\r\n]/.test(r.content)) {
    problems.push("content must be one line of at most 2048 characters");
  }
  if (r.type === "A" && !/^(\d{1,3})(\.\d{1,3}){3}$/.test(r.content))
    problems.push("an A record holds an IPv4 address");
  if (r.type === "AAAA" && !/^[0-9a-f:]+$/i.test(r.content)) problems.push("an AAAA record holds an IPv6 address");
  return problems;
}
