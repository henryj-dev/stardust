import { dnsProviderContract } from "@stardust/core/testing";
import { cloudflareDns } from "./cloudflare.ts";

const ZONE = "example.test";

/** Cloudflare's v4 API for one zone, in memory, paged as the real one is. */
function fakeCloudflare(): typeof fetch {
  const records: Array<{ id: string; name: string; type: string; content: string; ttl: number; proxied: boolean }> = [];
  let next = 1;
  const ok = (result: unknown, info?: unknown) =>
    Response.json({ success: true, errors: [], result, ...(info ? { result_info: info } : {}) });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/client\/v4/, "");
    if (new Headers(init?.headers).get("authorization") !== "Bearer t0ken") {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 403 },
      );
    }
    if (path === "/zones" && method === "GET") {
      const name = url.searchParams.get("name");
      const zones = [
        { id: "z1", name: ZONE },
        { id: "z2", name: "other.test" },
      ].filter((z) => !name || z.name === name);
      return ok(zones, { page: 1, total_pages: 1 });
    }
    const m = /^\/zones\/z1\/dns_records(?:\/([^/]+))?$/.exec(path);
    if (!m) return Response.json({ success: false, errors: [{ code: 7003, message: "No route" }] }, { status: 404 });
    const id = m[1];
    if (method === "GET") {
      const name = url.searchParams.get("name");
      const type = url.searchParams.get("type");
      const found = records.filter((r) => (!name || r.name === name) && (!type || r.type === type));
      // One record per page, to prove the adapter follows pages.
      const page = Number(url.searchParams.get("page") ?? "1");
      return ok(found.slice(page - 1, page), { page, total_pages: Math.max(1, found.length) });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === "POST") {
      const r = {
        id: `r${next++}`,
        name: String(body.name),
        type: String(body.type),
        content: String(body.content),
        ttl: Number(body.ttl),
        proxied: body.proxied === true,
      };
      records.push(r);
      return ok(r);
    }
    const i = records.findIndex((r) => r.id === id);
    if (i < 0)
      return Response.json(
        { success: false, errors: [{ code: 81044, message: "Record does not exist." }] },
        { status: 404 },
      );
    if (method === "PUT") {
      records[i] = {
        ...(records[i] as (typeof records)[number]),
        ...(body as object),
        id: id as string,
      } as (typeof records)[number];
      return ok(records[i]);
    }
    if (method === "DELETE") {
      records.splice(i, 1);
      return ok({ id });
    }
    return Response.json({ success: false }, { status: 405 });
  }) as typeof fetch;
}

dnsProviderContract("dns-cloudflare", ZONE, async () =>
  cloudflareDns({ token: "t0ken", fetch: fakeCloudflare(), zones: [ZONE] }),
);
