/**
 * Registration data over RDAP (RFC 9082/9083): who the registrar is and
 * when a domain expires. The server for a TLD comes from IANA's bootstrap
 * file; a registrar's own RDAP answer, when the registry links to one, is
 * read too, since it often has the dates the registry leaves out.
 */

export interface RdapResult {
  registrar: string | null;
  expires: string | null;
  registered: string | null;
  nameservers: string[];
  status: string[];
}

const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

interface RdapDoc {
  events?: Array<{ eventAction?: string; eventDate?: string }>;
  entities?: Array<{ roles?: string[]; vcardArray?: unknown[] }>;
  nameservers?: Array<{ ldhName?: string }>;
  status?: string[];
  links?: Array<{ rel?: string; type?: string; href?: string }>;
}

const fn = (entity: { vcardArray?: unknown[] }): string | null => {
  const props = entity.vcardArray?.[1];
  if (!Array.isArray(props)) return null;
  for (const p of props) if (Array.isArray(p) && p[0] === "fn" && typeof p[3] === "string") return p[3];
  return null;
};

function read(doc: RdapDoc): RdapResult {
  const events = Object.fromEntries((doc.events ?? []).map((e) => [e.eventAction ?? "", e.eventDate ?? ""]));
  const registrar = (doc.entities ?? []).find((e) => e.roles?.includes("registrar"));
  return {
    registrar: registrar ? fn(registrar) : null,
    expires: events.expiration || null,
    registered: events.registration || null,
    nameservers: (doc.nameservers ?? []).map((n) => (n.ldhName ?? "").toLowerCase()).filter(Boolean),
    status: doc.status ?? [],
  };
}

export function rdapClient(fetchFn: typeof fetch = fetch) {
  let servers: Promise<Map<string, string>> | null = null;
  const get = async (url: string): Promise<unknown> => {
    const res = await fetchFn(url, {
      headers: { accept: "application/rdap+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`RDAP ${new URL(url).host} answered ${res.status}`);
    return res.json();
  };
  const bootstrap = () => {
    servers ??= (get(BOOTSTRAP) as Promise<{ services?: Array<[string[], string[]]> }>)
      .then((b) => {
        const map = new Map<string, string>();
        for (const [tlds, urls] of b?.services ?? []) {
          const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
          if (url) for (const tld of tlds) map.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
        }
        return map;
      })
      .catch((err: Error) => {
        servers = null;
        throw err;
      });
    return servers;
  };

  return {
    /** Null when the registry has no record of the name. */
    async lookup(domain: string): Promise<RdapResult | null> {
      const name = domain.toLowerCase();
      if (!NAME.test(name)) throw new Error(`not a domain name: ${domain}`);
      const tld = name.slice(name.lastIndexOf(".") + 1);
      const server = (await bootstrap()).get(tld);
      if (!server) throw new Error(`no RDAP server is known for .${tld}`);
      const registry = (await get(`${server}domain/${encodeURIComponent(name)}`)) as RdapDoc | null;
      if (!registry) return null;
      const found = read(registry);
      // The registrar's answer, when the registry links to it: one hop, https only.
      const related = registry.links?.find(
        (l) => l.rel === "related" && l.type === "application/rdap+json" && l.href?.startsWith("https://"),
      );
      if (related?.href && (!found.expires || !found.registrar)) {
        const more = (await get(related.href).catch(() => null)) as RdapDoc | null;
        if (more) {
          const extra = read(more);
          return {
            registrar: found.registrar ?? extra.registrar,
            expires: found.expires ?? extra.expires,
            registered: found.registered ?? extra.registered,
            nameservers: found.nameservers.length ? found.nameservers : extra.nameservers,
            status: found.status.length ? found.status : extra.status,
          };
        }
      }
      return found;
    },
  };
}
