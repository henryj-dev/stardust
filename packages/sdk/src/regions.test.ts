/** Two regions shown as one: each project's work goes to its owner, and a region that is down fails only its own. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, createClient } from "./client.ts";
import { parseRegions } from "./regions.ts";

const AMS = "https://ams.stardust.test";
const FRA = "https://fra.stardust.test";
const projects = [
  { id: "shop", name: "Shop", githubRepo: "acme/shop", components: [], metadata: { region: "dev-ams" } },
  { id: "api", name: "API", githubRepo: "acme/api", components: [], metadata: { region: "prod-fra" } },
];

/** `hidden`: projects whose owner only the run route knows (shared, they carry no region). */
function world(down: Set<string> = new Set(), hidden: Record<string, string> = {}) {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const region = url.origin === AMS ? "dev-ams" : "prod-fra";
    if (down.has(region)) throw new TypeError("fetch failed");
    const method = init?.method ?? "GET";
    seen.push(`${region} ${method} ${url.pathname}`);
    if (url.pathname === "/api/v1/projects") {
      // Every region lists every project; only the owner knows its last run.
      return Response.json({
        projects: projects.map((p) => ({
          ...p,
          lastRun: p.metadata.region === region ? { id: `${region}-run` } : null,
        })),
      });
    }
    const one = /^\/api\/v1\/projects\/([^/]+)$/.exec(url.pathname);
    if (one && method === "GET") {
      const id = one[1] ?? "";
      return Response.json(
        projects.find((p) => p.id === id) ?? (hidden[id] ? { id, name: id, components: [], metadata: {} } : undefined),
      );
    }
    const runs = /^\/api\/v1\/projects\/([^/]+)\/runs$/.exec(url.pathname);
    if (runs) {
      const owner = projects.find((p) => p.id === runs[1])?.metadata.region ?? hidden[runs[1] ?? ""];
      if (owner !== region) return Response.json({ error: `belongs to ${owner}`, region: owner }, { status: 409 });
      return method === "POST"
        ? Response.json({ runId: `${region}-new` }, { status: 201 })
        : Response.json({ runs: [{ id: `${region}-run` }] });
    }
    return Response.json({ error: "no route" }, { status: 404 });
  }) as typeof fetch;
  const client = createClient({
    baseUrl: AMS,
    token: "t",
    fetch: fetchFn,
    regions: { urls: { "dev-ams": AMS, "prod-fra": FRA }, home: "dev-ams" },
  });
  return { client, seen };
}

describe("several regions as one", () => {
  it("lists projects once, each with its owner's last run, and sends a project's work to its owner", async () => {
    const { client, seen } = world();
    const list = await client.projects();
    assert.deepEqual(
      list.map((p) => [p.id, (p.lastRun as { id: string } | null)?.id]),
      [
        ["shop", "dev-ams-run"],
        ["api", "prod-fra-run"],
      ],
    );
    const started = (await client.pull("api")) as { runId: string };
    assert.equal(started.runId, "prod-fra-new");
    assert.ok(seen.includes("prod-fra POST /api/v1/projects/api/runs"));
    assert.ok(!seen.includes("dev-ams POST /api/v1/projects/api/runs"), "not sent home first");
  });

  it("with a region down, fails only what belongs to it", async () => {
    const { client } = world(new Set(["prod-fra"]));
    await assert.rejects(
      client.pull("api"),
      (err: unknown) => err instanceof ApiError && err.status === 503 && /prod-fra cannot be reached/.test(err.message),
    );
    assert.equal(((await client.pull("shop")) as { runId: string }).runId, "dev-ams-new");
    const list = await client.projects();
    assert.equal(list.length, 2, "the list still comes, from the region that answers");
  });

  it("with the home region down, reads what is shared elsewhere, and still changes the other region's projects", async () => {
    const { client } = world(new Set(["dev-ams"]));
    assert.equal((await client.projects()).length, 2);
    assert.equal(((await client.pull("api")) as { runId: string }).runId, "prod-fra-new");
    await assert.rejects(client.pull("shop"), /dev-ams cannot be reached/);
  });

  it("sends a change on to the region a refusal names, once", async () => {
    // Shared, the project says nothing of its owner (from before regions): it goes home, which names the owner.
    const { client, seen } = world(new Set(), { legacy: "prod-fra" });
    const out = (await client.pull("legacy")) as { runId: string };
    assert.deepEqual(
      seen.filter((x) => x.includes("POST")),
      ["dev-ams POST /api/v1/projects/legacy/runs", "prod-fra POST /api/v1/projects/legacy/runs"],
    );
    assert.equal(out.runId, "prod-fra-new");
  });

  it("reads the regions from a list, and refuses one it cannot read", () => {
    assert.deepEqual(parseRegions(`dev-ams=${AMS}, prod-fra=${FRA}`), { "dev-ams": AMS, "prod-fra": FRA });
    assert.throws(() => parseRegions("Bad=x"), /not a region/);
  });
});
