/**
 * Which DNS records and reverse name an instance gets. Pure, and tested,
 * because a mistake here does not fail: it sends traffic or mail to the
 * wrong place.
 *
 * - The public record: `<hostname> A <main IP>`, when the hostname lies in
 *   the configured zone.
 * - The internal record: `<short name>.<internal suffix> A <private IP>`,
 *   when the instance is on a private network and a suffix is configured.
 * - The reverse name (PTR) of the main IP is the hostname, and only when the
 *   public record exists: a mail receiver checks that the reverse name
 *   resolves back to the same address (forward-confirmed reverse DNS), and an
 *   internal name resolves to the private address instead.
 */

export interface DnsSettings {
  /** The dns port provider, e.g. `cloudflare`. */
  provider: string;
  /** The zone public records go in. */
  zone: string;
  /** Where internal names go, e.g. `internal.example.com` (in the same zone). */
  internalSuffix?: string;
  ttl?: number;
}

export interface PlannedRecord {
  name: string;
  type: "A" | "AAAA";
  content: string;
}

const inZone = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);

export function plannedRecords(
  hostname: string,
  addresses: { mainIp: string | null; ipv6: string | null; internalIp: string | null },
  dns: DnsSettings | undefined,
): { records: PlannedRecord[]; ptr: string | null } {
  if (!dns) return { records: [], ptr: null };
  const host = hostname.toLowerCase();
  const zone = dns.zone.toLowerCase();
  const records: PlannedRecord[] = [];
  const isPublic = inZone(host, zone) && addresses.mainIp !== null;
  if (isPublic && addresses.mainIp) records.push({ name: host, type: "A", content: addresses.mainIp });
  if (isPublic && addresses.ipv6) records.push({ name: host, type: "AAAA", content: addresses.ipv6 });
  if (dns.internalSuffix && addresses.internalIp) {
    const short = host.split(".")[0] ?? host;
    records.push({ name: `${short}.${dns.internalSuffix.toLowerCase()}`, type: "A", content: addresses.internalIp });
  }
  return { records, ptr: isPublic ? host : null };
}

/** cloud-init with `{{hostname}}` filled in; nothing else is substituted. */
export function renderCloudInit(template: string, hostname: string): string {
  return template.replaceAll("{{hostname}}", hostname);
}

/**
 * One user data from several parts (the configured cloud-init, and what the
 * hooks add): a single part as it is, several as a cloud-init multipart
 * message, each typed by its first line (`#cloud-config` or a `#!` script).
 */
export function combineUserData(parts: readonly string[], boundary = "stardust-part"): string | undefined {
  const kept = parts.filter((p) => p.trim() !== "");
  if (kept.length <= 1) return kept[0];
  const typeOf = (p: string) =>
    p.startsWith("#cloud-config") ? "text/cloud-config" : p.startsWith("#!") ? "text/x-shellscript" : "text/plain";
  const body = kept
    .map(
      (p) =>
        `--${boundary}\nContent-Type: ${typeOf(p)}; charset="utf-8"\nMIME-Version: 1.0\n\n${p.endsWith("\n") ? p : `${p}\n`}`,
    )
    .join("");
  return `Content-Type: multipart/mixed; boundary="${boundary}"\nMIME-Version: 1.0\n\n${body}--${boundary}--\n`;
}
