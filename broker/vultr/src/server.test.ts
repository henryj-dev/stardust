// Server tests. The policy tests (policy.test.ts) pin the decisions; these pin the wiring.
//
// Even with a correct policy, the broker breaks if the server does not call it, passes it the
// wrong body, or alters responses. Some things can only be checked at the server:
//
//   - Authentication (401) comes before any policy decision: an unauthenticated request must
//     not learn what the allowlist contains.
//   - A delete with a valid signed ticket is relayed, and the same ticket cannot be used twice.
//   - Vultr's status and body are relayed unchanged, as if the caller had called Vultr directly.
//   - The audit log never contains bodies: no `kvm` console URL, no `user_data` token.
//
// `fetch` is replaced with a stub standing in for Vultr; there is no network.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { signApproval } from "./policy.ts";

const BROKER = "tok-broker";
const APPROVAL = "tok-approval";
const ID = "6a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d";

process.env.VULTR_BROKER_TOKEN = BROKER;
process.env.VULTR_API_KEY = "tok-vultr-root";
process.env.VULTR_DELETE_APPROVAL_TOKEN = APPROVAL;
// Use the in-process ledger. Because of the interlock it only applies while
// `VULTR_REPLAY_DATABASE_URL` is unset. Without it these tests could not reach a delete that
// is actually relayed, or a replay refused with 409.
delete process.env.VULTR_REPLAY_DATABASE_URL;
process.env.VULTR_APPROVAL_REPLAY_IN_MEMORY = "1";

const { app } = await import("./index.ts");
const mod = { fetch: (r: Request) => Promise.resolve(app.fetch(r)) };

/** Statuses that cannot carry a body in a Fetch `Response`. */
const NULL_BODY = new Set([101, 204, 205, 304]);

interface Call {
  url: string;
  method: string;
  auth: string;
  body?: string | undefined;
}
let calls: Call[] = [];
let nextRes: { status: number; body: string } = { status: 200, body: "{}" };
const realFetch = globalThis.fetch;
let logs: string[] = [];
const realLog = console.log;

beforeEach(() => {
  calls = [];
  nextRes = { status: 200, body: "{}" };
  logs = [];
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
      body: init?.body as string | undefined,
    });
    return new Response(NULL_BODY.has(nextRes.status) ? null : nextRes.body, { status: nextRes.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

function req(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: string | false; headers?: Record<string, string> } = {},
): Request {
  const h: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.auth !== false) h.Authorization = `Bearer ${opts.auth ?? BROKER}`;
  return new Request(`http://broker${path}`, {
    method,
    headers: h,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("authentication", () => {
  it("healthz needs no token", async () => {
    const res = await mod.fetch(new Request("http://broker/healthz"));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { service?: string }).service, "vultr-broker");
  });

  it("no token is a 401 and Vultr is not called", async () => {
    const res = await mod.fetch(req("GET", "/instances", { auth: false }));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  it("a wrong token is a 401", async () => {
    const res = await mod.fetch(req("GET", "/instances", { auth: "wrong" }));
    assert.equal(res.status, 401);
  });

  it("authentication comes before the allowlist: unauthenticated is a 401, not a 403", async () => {
    // A forbidden path without a token must be a 401, so the allowlist does not leak to strangers.
    const res = await mod.fetch(req("GET", "/account", { auth: false }));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

describe("relay: passed through unchanged", () => {
  it("an allowed GET goes to Vultr as is, query included", async () => {
    nextRes = { status: 200, body: '{"instances":[]}' };
    const res = await mod.fetch(req("GET", "/instances?per_page=500"));
    assert.equal(res.status, 200);
    assert.equal(calls[0]?.url, "https://api.vultr.com/v2/instances?per_page=500");
    assert.equal(calls[0]?.auth, "Bearer tok-vultr-root"); // only the broker adds the account key
    assert.equal(await res.text(), '{"instances":[]}');
  });

  it("the upstream status is relayed as is (not hidden behind a 200)", async () => {
    nextRes = { status: 412, body: '{"error":"precondition"}' };
    const res = await mod.fetch(req("GET", `/instances/${ID}`));
    assert.equal(res.status, 412);
    assert.equal(await res.text(), '{"error":"precondition"}');
  });

  it("an upstream exception is a 502", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await mod.fetch(req("GET", "/instances"));
    assert.equal(res.status, 502);
  });

  it("a forbidden path does not call Vultr", async () => {
    const res = await mod.fetch(req("GET", "/account"));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });
});

describe("PATCH body check wiring", () => {
  it("allowed keys are relayed with the body unchanged", async () => {
    const res = await mod.fetch(req("PATCH", `/instances/${ID}`, { body: { user_data: "eA==" } }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), { user_data: "eA==" });
  });

  it("a forbidden key is a 400 and Vultr is not called", async () => {
    const res = await mod.fetch(req("PATCH", `/instances/${ID}`, { body: { backups: "enabled" } }));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
    assert.ok(((await res.json()) as { error?: string }).error?.includes("backups"));
  });

  // `plan` is open and its value is the ceiling. This checks the wiring too: the policy
  // unit tests alone cannot show that the server calls that check.
  it("a listed plan is relayed with the body unchanged", async () => {
    const res = await mod.fetch(req("PATCH", `/instances/${ID}`, { body: { plan: "vc2-2c-4gb" } }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), { plan: "vc2-2c-4gb" });
  });

  it("an unlisted plan is a 403 and Vultr is not called", async () => {
    const res = await mod.fetch(req("PATCH", `/instances/${ID}`, { body: { plan: "vc2-16c-64gb" } }));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
    assert.ok(((await res.json()) as { error?: string }).error?.includes("vc2-16c-64gb"));
  });

  it("os_id (a reinstall destroys data) is a 400", async () => {
    const res = await mod.fetch(req("PATCH", `/instances/${ID}`, { body: { os_id: 2136 } }));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("a forbidden key mixed with allowed ones refuses the whole request (no filtering)", async () => {
    const res = await mod.fetch(req("PATCH", `/instances/${ID}`, { body: { user_data: "ok", detach_vpc: [ID] } }));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("broken JSON is a 400", async () => {
    const r = new Request(`http://broker/instances/${ID}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${BROKER}` },
      body: "{not json",
    });
    const res = await mod.fetch(r);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});

describe("DELETE approval wiring", () => {
  const ticket = (over: Partial<{ target: string; jti: string; iat: number; exp: number }> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return signApproval(
      {
        v: 1,
        purpose: "instance-destroy",
        target: over.target ?? ID,
        actor: "tester",
        jti: over.jti ?? "11111111-2222-4333-8444-555555555555",
        iat: over.iat ?? now,
        exp: over.exp ?? now + 120,
      },
      APPROVAL,
    );
  };

  it("a delete without the approval header is a 403 and Vultr is not called", async () => {
    const res = await mod.fetch(req("DELETE", `/instances/${ID}`));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  // The fixed shared token is refused. The ticket only adds anything while this stays
  // green: if the old path came back, this catches it.
  it("the old fixed shared token no longer works and Vultr is not called", async () => {
    const res = await mod.fetch(req("DELETE", `/instances/${ID}`, { headers: { "X-Delete-Approval": APPROVAL } }));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("a valid ticket relays the delete", async () => {
    nextRes = { status: 204, body: "" };
    const res = await mod.fetch(
      req("DELETE", `/instances/${ID}`, {
        headers: { "X-Delete-Approval": ticket({ jti: "aaaaaaaa-1111-4111-8111-111111111111" }) },
      }),
    );
    assert.equal(res.status, 204);
    assert.equal(calls.at(-1)?.method, "DELETE");
    assert.equal(calls.at(-1)?.url, `https://api.vultr.com/v2/instances/${ID}`);
  });

  // This is why tickets exist: the second use of the same ticket is blocked.
  //
  // What this test cannot catch: removing the `consume()` call after a successful relay
  // leaves it green. The in-process guard records the jti as soon as it is claimed, so the
  // second use is blocked anyway. The PostgreSQL ledger is different: a `processing` row can
  // be reclaimed once its 30 second lease expires, so without `consume()` the same ticket
  // would work again 30 seconds later. The in-process guard does not model lease expiry and
  // is blind to that defect by design.
  //
  // This is written down so a passing test is not read as proof of the property. Closing
  // the gap would mean the guard imitating the lease (with an injected clock), turning it
  // into a second ledger implementation; knowing the limit was preferred.
  it("reusing a ticket is a 409 and Vultr is not called twice", async () => {
    nextRes = { status: 204, body: "" };
    const t = ticket({ jti: "bbbbbbbb-2222-4222-8222-222222222222" });
    const first = await mod.fetch(req("DELETE", `/instances/${ID}`, { headers: { "X-Delete-Approval": t } }));
    assert.equal(first.status, 204);
    const before = calls.length;
    const second = await mod.fetch(req("DELETE", `/instances/${ID}`, { headers: { "X-Delete-Approval": t } }));
    assert.equal(second.status, 409);
    assert.equal(calls.length, before);
  });

  it("a ticket-shaped token with a bad signature is a 403, refused before the ledger", async () => {
    // No ledger can be reached in some of these tests, so a 403 rather than a 503 shows
    // that the signature is checked before the ledger.
    const res = await mod.fetch(
      req("DELETE", `/instances/${ID}`, { headers: { "X-Delete-Approval": `${ticket()}x` } }),
    );
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("a valid signature for another target is a 403: a ticket is bound to one instance", async () => {
    const other = "99999999-8888-4777-8666-555555555555";
    const res = await mod.fetch(
      req("DELETE", `/instances/${ID}`, { headers: { "X-Delete-Approval": ticket({ target: other }) } }),
    );
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("an expired ticket is a 403", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await mod.fetch(
      req("DELETE", `/instances/${ID}`, {
        headers: { "X-Delete-Approval": ticket({ iat: now - 200, exp: now - 1 }) },
      }),
    );
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("a valid ticket is a 503 when the ledger is unavailable: no single use, no pass", async () => {
    // The in-memory ledger is turned off, so this takes the PostgreSQL path, which fails for
    // lack of a URL: it really exercises fail-closed. A 204 here would mean "no ledger, just
    // let it through", which is no stronger than a fixed token. Both the refusing path and
    // the passing path must be exercised for the pair to mean anything ("a valid ticket
    // relays the delete" above is the other half).
    delete process.env.VULTR_APPROVAL_REPLAY_IN_MEMORY;
    try {
      const res = await mod.fetch(
        req("DELETE", `/instances/${ID}`, {
          headers: { "X-Delete-Approval": ticket({ jti: "cccccccc-3333-4333-8333-333333333333" }) },
        }),
      );
      assert.equal(res.status, 503);
      assert.equal(calls.length, 0);
    } finally {
      process.env.VULTR_APPROVAL_REPLAY_IN_MEMORY = "1";
    }
  });

  it("an arbitrary string is a 403", async () => {
    const res = await mod.fetch(req("DELETE", `/instances/${ID}`, { headers: { "X-Delete-Approval": "nope" } }));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  // There is deliberately no rollback ticket (see the top of policy.ts). This pins that
  // such a header does not come back as a bypass.
  it("an X-Rollback-Ticket header does not get around approval", async () => {
    const res = await mod.fetch(req("DELETE", `/instances/${ID}`, { headers: { "X-Rollback-Ticket": "anything" } }));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("the create response is relayed unchanged (no ticket header is added)", async () => {
    nextRes = { status: 202, body: JSON.stringify({ instance: { id: ID, label: "x" } }) };
    const res = await mod.fetch(req("POST", "/instances", { body: { region: "ewr" } }));
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("X-Rollback-Ticket"), null);
    assert.deepEqual(JSON.parse(await res.text()), { instance: { id: ID, label: "x" } });
  });
});

describe("audit log: no credentials leak", () => {
  it("the request body (a user_data token) is not logged", async () => {
    const secret = "NODE_REPORT_TOKEN_SUPERSECRET";
    await mod.fetch(req("PATCH", `/instances/${ID}`, { body: { user_data: secret } }));
    assert.ok(!logs.join("\n").includes(secret));
  });

  it("the response body (a kvm console URL) is not logged", async () => {
    const kvm = "https://my.vultr.com/subs/vps/novnc/api.php?token=LEAKED";
    nextRes = { status: 202, body: JSON.stringify({ instance: { id: ID, kvm } }) };
    await mod.fetch(req("POST", "/instances", { body: {} }));
    const all = logs.join("\n");
    assert.ok(!all.includes("LEAKED"));
    assert.ok(!all.includes("novnc"));
  });

  it("the account key is not logged", async () => {
    await mod.fetch(req("GET", "/instances"));
    assert.ok(!logs.join("\n").includes("tok-vultr-root"));
  });

  it("a refusal logs the path and the reason (it must be diagnosable)", async () => {
    await mod.fetch(req("GET", "/account"));
    const all = logs.join("\n");
    assert.ok(all.includes("denied"));
    assert.ok(all.includes("/account"));
  });
});

// The broker does not trust its caller, so having a single caller is no reason to skip a limit.
describe("body limit", () => {
  it("a body over the limit is a 413 and does not reach Vultr", async () => {
    const before = calls.length;
    const res = await mod.fetch(
      new Request("http://b/instances", {
        method: "POST",
        headers: { Authorization: `Bearer ${BROKER}` },
        body: "x".repeat(300 * 1024),
      }),
    );
    assert.equal(res.status, 413);
    assert.equal(calls.length, before); // Vultr was not called
  });

  it("a body within the limit passes through", async () => {
    const res = await mod.fetch(
      new Request("http://b/instances", {
        method: "POST",
        headers: { Authorization: `Bearer ${BROKER}` },
        body: JSON.stringify({ region: "ewr", plan: "vc2-1c-1gb" }),
      }),
    );
    assert.ok(res.status < 400, String(res.status));
  });
});
