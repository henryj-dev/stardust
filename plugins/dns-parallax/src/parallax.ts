/**
 * DNS on parallax: split-horizon zones with an `internal` and an `external`
 * view. parallax stores a write as a new zone revision and publishes it
 * when the view is applied, so every write here is followed by an apply of
 * that view at that revision; `waitApplied` waits until each view serves it.
 * Names are relative to the zone there (`@` for the apex).
 */
import {
  type DnsProvider,
  type DnsRecord,
  type DnsRecordType,
  dnsRecordProblems,
  normalizeDnsName,
} from "@stardust/core";

export interface ParallaxOptions {
  apiUrl: string;
  token: string;
  /** The views stardust writes to; both by default. */
  views?: readonly string[];
  fetch?: typeof fetch;
  /** How long `waitApplied` waits. */
  applyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface PxRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  view: string;
}

export class ParallaxError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ParallaxError";
    this.status = status;
  }
}

export function parallaxDns(options: ParallaxOptions): DnsProvider {
  const base = options.apiUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const views = options.views ?? ["internal", "external"];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Per zone, the views this provider wrote and the revision each write made: what waitApplied waits for. */
  const written = new Map<string, Map<string, number>>();

  async function call(method: string, path: string, init: { body?: unknown; ifMatch?: string } = {}) {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.ifMatch ? { "if-match": `"${init.ifMatch}"` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (res.status >= 400) {
      const code = typeof json.error === "string" ? ` (${json.error})` : "";
      throw new ParallaxError(`parallax ${method} ${path.split("?")[0]} answered ${res.status}${code}`, res.status);
    }
    // The ETag is the revision; the body's `revision` is the fallback.
    const etag = res.headers.get("etag")?.replace(/^W\//, "").replace(/"/g, "") ?? null;
    return { json, revision: etag ?? (json.revision === undefined ? null : String(json.revision)) };
  }

  const z = (zone: string) => encodeURIComponent(normalizeDnsName(zone));
  const relative = (zone: string, name: string) => {
    const n = normalizeDnsName(name);
    const zn = normalizeDnsName(zone);
    return n === zn ? "@" : n.slice(0, -(zn.length + 1));
  };
  const absolute = (zone: string, name: string) =>
    name === "@" ? normalizeDnsName(zone) : `${name}.${normalizeDnsName(zone)}`;
  const toRecord = (zone: string, r: PxRecord): DnsRecord => ({
    id: r.id,
    name: absolute(zone, r.name),
    type: r.type as DnsRecordType,
    content: r.content,
    ttl: r.ttl,
    view: r.view,
    ...(r.proxied !== undefined ? { proxied: r.proxied } : {}),
  });
  const checkView = (view: string | undefined) => {
    const v = view ?? views[0];
    if (!v || !views.includes(v)) throw new Error(`view must be one of ${views.join(", ")}`);
    return v;
  };

  async function listIn(zone: string, view: string, filter: { name?: string; type?: string }): Promise<DnsRecord[]> {
    const out: DnsRecord[] = [];
    for (let offset = 0; ; ) {
      const query = new URLSearchParams({ limit: "500", offset: String(offset) });
      if (filter.name) query.set("name", relative(zone, filter.name));
      if (filter.type) query.set("type", filter.type);
      const { json } = await call("GET", `/api/v1/zones/${z(zone)}/views/${encodeURIComponent(view)}/records?${query}`);
      const records = (json.records ?? []) as PxRecord[];
      out.push(...records.map((r) => toRecord(zone, { ...r, view: r.view ?? view })));
      if (json.hasMore !== true || records.length === 0) return out;
      offset += records.length;
    }
  }

  /** Publishes a view at the revision a write produced: a write alone is only a draft in parallax. */
  async function apply(zone: string, view: string, revision: string | null) {
    await call(
      "POST",
      `/api/v1/zones/${z(zone)}/apply?view=${encodeURIComponent(view)}`,
      revision ? { ifMatch: revision } : {},
    );
  }

  return {
    capabilities: { views, proxied: true, asyncApply: true },
    async listZones() {
      const out: string[] = [];
      for (let offset = 0; ; ) {
        const { json } = await call("GET", `/api/v1/zones?limit=500&offset=${offset}`);
        const zones = (json.zones ?? []) as Array<{ name: string }>;
        out.push(...zones.map((zone) => normalizeDnsName(zone.name)));
        if (json.hasMore !== true || zones.length === 0) return out.sort();
        offset += zones.length;
      }
    },
    async listRecords(zone, filter = {}) {
      const scope = filter.view ? [checkView(filter.view)] : views;
      const all = await Promise.all(scope.map((v) => listIn(zone, v, filter)));
      return all.flat();
    },
    async upsert(zone, record) {
      const problems = dnsRecordProblems(zone, record);
      if (problems.length > 0) throw new Error(problems.join("; "));
      const view = checkView(record.view);
      const name = relative(zone, record.name);
      const body = {
        name,
        type: record.type,
        content: record.content,
        ttl: record.ttl,
        ...(view === "external" && record.proxied !== undefined ? { proxied: record.proxied } : {}),
      };
      const [existing] = await listIn(zone, view, { name: record.name, type: record.type });
      const v = encodeURIComponent(view);
      const saved = existing
        ? await call("PUT", `/api/v1/zones/${z(zone)}/views/${v}/records/${encodeURIComponent(existing.id)}`, { body })
        : await call("POST", `/api/v1/zones/${z(zone)}/views/${v}/records`, { body });
      await apply(zone, view, saved.revision);
      return toRecord(zone, { ...(saved.json.record as PxRecord), view });
    },
    async delete(zone, id, view) {
      const v = checkView(view);
      try {
        const gone = await call(
          "DELETE",
          `/api/v1/zones/${z(zone)}/views/${encodeURIComponent(v)}/records/${encodeURIComponent(id)}`,
        );
        await apply(zone, v, gone.revision);
      } catch (err) {
        if (err instanceof ParallaxError && err.status === 404) return;
        throw err;
      }
    },
    async waitApplied(zone) {
      // A view serves our write once it has applied the revision that write made; views we did not write are not waited for.
      const wanted = written.get(normalizeDnsName(zone));
      if (!wanted || wanted.size === 0) return;
      const deadline = Date.now() + (options.applyTimeoutMs ?? 60_000);
      for (;;) {
        const { json } = await call("GET", `/api/v1/zones/${z(zone)}/status`);
        const statuses = (json.statuses ?? []) as Array<{ view?: string; state?: string; appliedRevision?: unknown }>;
        const late = [...wanted].filter(([view, revision]) => {
          const s = statuses.find((x) => x.view === view);
          return !(s && s.state === "applied" && Number(s.appliedRevision) >= revision);
        });
        if (late.length === 0) {
          written.delete(normalizeDnsName(zone));
          return;
        }
        if (Date.now() >= deadline) {
          const state = late.map(([view, revision]) => `${view} wants ${revision}`).join(", ");
          throw new Error(`parallax has not published ${zone} yet (${state}): stored, not yet served`);
        }
        await sleep(1_000);
      }
    },
  };
}
