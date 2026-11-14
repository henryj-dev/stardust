import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dnsProviderContract } from "@stardust/core/testing";
import { parallaxDns } from "./parallax.ts";

const ZONE = "example.test";

/** parallax's API for one zone: writes make revisions, and only an apply publishes them. */
function fakeParallax() {
  const records: Array<{ id: string; name: string; type: string; content: string; ttl: number; view: string }> = [];
  let revision = 1;
  const applied: Record<string, number> = { internal: 1, external: 1 };
  const applies: Array<{ view: string; ifMatch: string | null }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", etag: `"${revision}"` },
    });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== "Bearer t0ken") return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/api/v1/zones")
      return json({ zones: [{ name: ZONE }], limit: 500, offset: 0, hasMore: false });
    if (url.pathname === `/api/v1/zones/${ZONE}/apply` && method === "POST") {
      const view = url.searchParams.get("view") ?? "";
      const ifMatch = headers.get("if-match");
      if (ifMatch && ifMatch !== `"${revision}"`) return json({ error: "revision-mismatch" }, 409);
      applies.push({ view, ifMatch });
      applied[view] = revision;
      return json({ ok: true });
    }
    if (url.pathname === `/api/v1/zones/${ZONE}/status`) {
      return json({
        zone: ZONE,
        statuses: Object.entries(applied).map(([view, a]) => ({
          view,
          state: a >= revision ? "applied" : "pending",
          appliedRevision: a,
          desiredRevision: revision,
        })),
      });
    }
    const m = new RegExp(`^/api/v1/zones/${ZONE}/views/(internal|external)/records(?:/([^/]+))?$`).exec(url.pathname);
    if (!m) return json({ error: "not-found" }, 404);
    const [, view, id] = m;
    if (method === "GET") {
      const name = url.searchParams.get("name");
      const type = url.searchParams.get("type");
      const found = records.filter((r) => r.view === view && (!name || r.name === name) && (!type || r.type === type));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      // One per page, to prove the adapter follows pages.
      return json({
        records: found.slice(offset, offset + 1),
        limit: 1,
        offset,
        hasMore: offset + 1 < found.length,
        total: found.length,
        revision,
      });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === "POST") {
      const r = {
        id: `${String(body.name)}-${String(body.type)}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
        name: String(body.name),
        type: String(body.type),
        content: String(body.content),
        ttl: Number(body.ttl),
        view: view as string,
      };
      records.push(r);
      revision++;
      return json({ record: r, revision }, 201);
    }
    const i = records.findIndex((r) => r.view === view && r.id === id);
    if (i < 0) return json({ error: "not-found" }, 404);
    if (method === "PUT") {
      records[i] = {
        ...(records[i] as (typeof records)[number]),
        name: String(body.name),
        type: String(body.type),
        content: String(body.content),
        ttl: Number(body.ttl),
      };
      revision++;
      return json({ record: records[i], revision });
    }
    if (method === "DELETE") {
      records.splice(i, 1);
      revision++;
      return json({ revision });
    }
    return json({ error: "method" }, 405);
  }) as typeof fetch;
  return { fetchFn, applies, records };
}

dnsProviderContract("dns-parallax", ZONE, async () =>
  parallaxDns({ apiUrl: "https://px.test", token: "t0ken", fetch: fakeParallax().fetchFn }),
);

describe("dns-parallax", () => {
  it("publishes every write by applying its view at the revision it made, and waits until served", async () => {
    const px = fakeParallax();
    const dns = parallaxDns({ apiUrl: "https://px.test", token: "t0ken", fetch: px.fetchFn, sleep: async () => {} });
    await dns.upsert(ZONE, { name: `api.${ZONE}`, type: "A", content: "10.0.0.5", ttl: 60, view: "internal" });
    assert.deepEqual(px.applies, [{ view: "internal", ifMatch: '"2"' }]);
    assert.equal(px.records[0]?.name, "api", "stored relative to the zone");
    await dns.upsert(ZONE, { name: ZONE, type: "TXT", content: "apex", ttl: 60, view: "external" });
    assert.equal(px.records[1]?.name, "@", "the apex is @");
    await dns.waitApplied?.(ZONE);
  });

  it("refuses a view it does not write to", async () => {
    const dns = parallaxDns({
      apiUrl: "https://px.test",
      token: "t0ken",
      fetch: fakeParallax().fetchFn,
      views: ["internal"],
    });
    await assert.rejects(
      dns.upsert(ZONE, { name: `api.${ZONE}`, type: "A", content: "10.0.0.5", ttl: 60, view: "external" }),
      /view must be one of internal/,
    );
  });
});
