import assert from "node:assert/strict";
import { it } from "node:test";
import { cloudflareAudit, normalizeV1 } from "./index.ts";

const ACCOUNT = "0".repeat(32);
const raw = (i: number) => ({
  id: `r${i}`,
  when: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  action: { type: "dns_record_update", result: i % 7 !== 0 },
  actor: { type: "account_token", id: "t".repeat(32), ip: "192.0.2.1" },
  interface: "api.example.com",
  resource: { type: "dns", id: `z${i}` },
});

function fake(total: number, seen: URL[] = []) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url);
    const page = Number(url.searchParams.get("page"));
    const per = Number(url.searchParams.get("per_page"));
    const rows = Array.from({ length: Math.max(0, Math.min(per, total - (page - 1) * per)) }, (_, i) =>
      raw((page - 1) * per + i),
    );
    return Response.json({ success: true, result: rows });
  }) as typeof fetch;
}

it("reads a window oldest first, page by page, with both bounds", async () => {
  const seen: URL[] = [];
  const window = await cloudflareAudit({ accountId: ACCOUNT, token: "t", fetch: fake(450, seen) }).read(
    new Date(0),
    new Date(1e12),
  );
  assert.equal(window.records.length, 450);
  assert.equal(window.truncated, false);
  assert.equal(seen.length, 3);
  assert.equal(seen[0]?.pathname, `/client/v4/accounts/${ACCOUNT}/audit_logs`);
  assert.equal(seen[0]?.searchParams.get("direction"), "asc");
  assert.ok(seen[0]?.searchParams.get("since") && seen[0]?.searchParams.get("before"));
  assert.equal(window.records[7]?.result, false);
});

it("says when it stopped early instead of skipping what it did not read", async () => {
  const window = await cloudflareAudit({ accountId: ACCOUNT, token: "t", fetch: fake(5000) }).read(
    new Date(0),
    new Date(1e12),
  );
  assert.equal(window.records.length, 4000);
  assert.equal(window.truncated, true);
});

it("fails loudly on an error answer", async () => {
  const denied = (async () =>
    Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 })) as typeof fetch;
  await assert.rejects(
    cloudflareAudit({ accountId: ACCOUNT, token: "t", fetch: denied }).read(new Date(0), new Date()),
    /403: Authentication error/,
  );
});

it("normalizes odd records instead of dropping them", () => {
  assert.deepEqual(normalizeV1(null), {
    id: "",
    when: "",
    actionType: "",
    actorType: "unknown",
    actorId: "",
    actorEmail: "",
    actorIp: "",
    interfaceHost: "",
    resourceType: "",
    resourceId: "",
    result: true,
  });
  assert.equal(normalizeV1({ actor: { type: "robot" } }).actorType, "unknown");
});
