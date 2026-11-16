import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { computeProviderContract } from "@stardust/core/testing";
import { decideFallback, VultrHttpError, vultrClient } from "./client.ts";
import { vultrCompute } from "./vultr.ts";

interface Call {
  base: string;
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
  headers: Headers;
}

/** Vultr's v2 API in memory, enough for the port; every call is recorded. */
function fakeVultr(calls: Call[] = []) {
  const instances = new Map<string, Record<string, unknown>>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace(/^\/v2/, "");
    calls.push({ base: url.origin, method, path, auth: headers.get("authorization"), body, headers });
    if (method === "GET" && path === "/regions")
      return json(200, { regions: [{ id: "ams", city: "Amsterdam", country: "NL" }] });
    if (method === "GET" && path === "/plans")
      return json(200, {
        plans: [
          { id: "vc2-1c-1gb", vcpu_count: 1, ram: 1024, disk: 25, monthly_cost: 5, locations: ["ams"] },
          { id: "vc2-2c-4gb", vcpu_count: 2, ram: 4096, disk: 80, monthly_cost: 20, locations: ["ams"] },
        ],
      });
    if (method === "GET" && path === "/os") return json(200, { os: [{ id: 2284, name: "Rocky Linux 10 x64" }] });
    if (method === "GET" && path === "/ssh-keys") return json(200, { ssh_keys: [{ id: "k1", name: "ops" }] });
    if (method === "GET" && path === "/vpcs")
      return json(200, {
        vpcs: [{ id: "v1", description: "private", region: "ams", v4_subnet: "10.10.0.0", v4_subnet_mask: 20 }],
      });
    if (method === "GET" && path === "/instances")
      return json(200, { instances: [...instances.values()], meta: { links: { next: "" } } });
    if (method === "POST" && path === "/instances") {
      const b = body as Record<string, unknown>;
      const made = {
        id: randomUUID(),
        label: b.label,
        hostname: b.hostname,
        region: b.region,
        plan: b.plan,
        os: "",
        status: "pending",
        power_status: "running",
        main_ip: "0.0.0.0",
        tags: b.tags ?? [],
        user_data: b.user_data,
      };
      instances.set(made.id, made);
      return json(202, { instance: made });
    }
    const one = /^\/instances\/([0-9a-f-]{36})$/.exec(path);
    if (one) {
      const found = instances.get(one[1] ?? "");
      if (!found) return json(404, { error: "Not found" });
      if (method === "GET")
        return json(200, { instance: { ...found, kvm: "https://my.vultr.com/subs/vps/novnc/api.php?data=x" } });
      if (method === "PATCH") {
        Object.assign(found, body as Record<string, unknown>);
        return new Response("", { status: 202 });
      }
      if (method === "DELETE") {
        instances.delete(one[1] ?? "");
        return new Response(null, { status: 204 });
      }
    }
    if (method === "POST" && /^\/instances\/[0-9a-f-]{36}\/ipv[46]\/reverse$/.test(path))
      return new Response(null, { status: 204 });
    return json(404, { error: `no route ${method} ${path}` });
  }) as typeof fetch;
  return { fetchFn, instances, calls };
}

computeProviderContract("vultr", async () => vultrCompute(vultrClient({ apiKey: "key", fetch: fakeVultr().fetchFn })));

describe("calls through the broker", () => {
  const BROKER = "http://broker.test:8080";
  /** A broker that answers with `status`, or cannot be reached when status is null; Vultr itself works. */
  function setup(status: number | null, apiKey?: string) {
    const vultr = fakeVultr();
    const fallbacks: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith(BROKER)) {
        if (status === null) throw new TypeError("fetch failed: connect ECONNREFUSED");
        vultr.calls.push({
          base: BROKER,
          method: init?.method ?? "GET",
          path: new URL(String(input)).pathname,
          auth: null,
          body: undefined,
          headers: new Headers(init?.headers),
        });
        return new Response(JSON.stringify({ error: "denied" }), { status });
      }
      return vultr.fetchFn(input, init);
    }) as typeof fetch;
    const client = vultrClient({
      broker: { url: BROKER, token: "broker-token" },
      ...(apiKey ? { apiKey } : {}),
      fetch: fetchFn,
      onFallback: (call) => fallbacks.push(call),
    });
    return { compute: vultrCompute(client), vultr, fallbacks };
  }
  const direct = (calls: Call[]) => calls.filter((c) => c.base !== BROKER);

  for (const status of [401, 403, 502]) {
    it(`never falls back on an HTTP answer from the broker (${status}), even with a key`, async () => {
      const { compute, vultr, fallbacks } = setup(status, "root-key");
      await assert.rejects(compute.list(), (err: unknown) => err instanceof VultrHttpError && err.status === status);
      assert.deepEqual(direct(vultr.calls), [], "the key was not used");
      assert.deepEqual(fallbacks, []);
    });
  }

  it("falls back to the key only when the broker cannot be reached, and says so", async () => {
    const { compute, vultr, fallbacks } = setup(null, "root-key");
    assert.deepEqual(await compute.list(), []);
    assert.equal(direct(vultr.calls)[0]?.auth, "Bearer root-key");
    assert.deepEqual(fallbacks, ["GET /instances?per_page=500"]);
  });

  it("without a key, an unreachable broker is an error that names the missing fallback", async () => {
    const { compute } = setup(null);
    await assert.rejects(compute.list(), /cannot be reached and no direct key is configured/);
  });

  it("decides a fallback from the failure alone", () => {
    assert.deepEqual(decideFallback(new VultrHttpError("/x", 403, ""), true), { fallback: false, rethrow: true });
    assert.equal(decideFallback(new TypeError("fetch failed"), true).fallback, true);
    assert.equal(decideFallback(new TypeError("fetch failed"), false).fallback, false);
  });
});

describe("what goes to Vultr", () => {
  it("sends the approval with a delete, user data as base64, and refuses ids that are not Vultr's", async () => {
    const vultr = fakeVultr();
    const compute = vultrCompute(vultrClient({ apiKey: "key", fetch: vultr.fetchFn }));
    const made = await compute.create({
      label: "web 1",
      hostname: "web-1.example.test",
      region: "ams",
      plan: "vc2-1c-1gb",
      image: "2284",
      userData: "#cloud-config\nsecret: x\n",
    });
    const posted = vultr.calls.find((c) => c.method === "POST")?.body as Record<string, unknown>;
    assert.equal(Buffer.from(String(posted.user_data), "base64").toString(), "#cloud-config\nsecret: x\n");
    assert.equal(posted.os_id, 2284);
    assert.equal(made.os, null, "an OS Vultr leaves out is unknown, not none");
    assert.equal(made.mainIp, null, "0.0.0.0 is no address yet");
    await compute.clearUserData(made.id, "enrolled");
    assert.match(
      Buffer.from(String(vultr.instances.get(made.id)?.user_data), "base64").toString(),
      /cleared after the instance came up: enrolled/,
    );
    assert.match((await compute.console?.(made.id)) ?? "", /novnc/);
    await compute.destroy(made.id, "ada");
    assert.equal(vultr.calls.at(-1)?.method, "DELETE");
    await assert.rejects(compute.resize?.("../account", "vc2-2c-4gb") ?? Promise.resolve(), /not a Vultr instance id/);
    assert.equal(await compute.get("not-an-id"), null);
  });
});

describe("delete tickets for the broker", () => {
  it("signs one for this instance and approver, canonical and short-lived", async () => {
    const vultr = fakeVultr();
    const compute = vultrCompute(vultrClient({ apiKey: "key", fetch: vultr.fetchFn }), {
      deleteApprovalKey: "shared",
      now: () => 1_700_000_000_000,
    });
    const made = await compute.create({
      label: "x",
      hostname: "x.example.test",
      region: "ams",
      plan: "vc2-1c-1gb",
      image: "2284",
    });
    await compute.destroy(made.id, "ada");
    const ticket = vultr.calls.at(-1)?.headers.get("x-delete-approval") ?? "";
    const [v, payload, sig] = ticket.split(".");
    assert.equal(v, "v1");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(claims), ["actor", "exp", "iat", "jti", "purpose", "target", "v"], "fixed key order");
    assert.equal(claims.target, made.id);
    assert.equal(claims.actor, "ada");
    assert.equal(claims.purpose, "instance-destroy");
    assert.ok((claims.exp as number) - (claims.iat as number) <= 300);
    const { createHmac } = await import("node:crypto");
    assert.equal(sig, createHmac("sha256", "shared").update(`v1.${payload}`).digest("base64url"));
  });
});
