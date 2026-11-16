// The Vultr API key broker: the smallest service that can hold the Vultr API key.
//
// Why it exists: a Vultr personal access token has full access to the whole account, and
// Vultr offers no scoped keys. If the key lived in stardust, which receives webhooks, serves
// the dashboard and talks to Kubernetes, GitHub and the database, any vulnerability there
// would hand over the whole Vultr account. The key cannot be narrowed, so it is isolated
// here behind an allowlist of operations.
//
// The broker is trusted not because it is safe but because it is small enough to audit. It
// concentrates the key rather than moving it, so every line added here weakens that case.
// The rules:
//
//   - Two routes only: `GET /healthz` and the relay catch-all.
//   - No shell, no filesystem writes, no path building.
//   - One database, used only for delete approval tickets. The connection is opened lazily
//     and only on that path, so if the database is down only that delete is refused; every
//     other route keeps working.
//   - Every decision lives in `policy.ts`, a pure module pinned by tests. This file asks the
//     policy and relays what passes, nothing more.
//   - The only egress is `api.vultr.com` (plus that database), enforced by network policy.
//   - Authorization of users (roles, one-time passwords) happens at the dashboard, not here.
//     Delete approval is the one exception the broker checks itself.

import { Hono } from "hono";
import { fromPostgres, PostgresApprovalReplayStore, requireReplayDatabaseUrl } from "./approval-replay-store.ts";
import {
  ApprovalReplayGuard,
  type ApprovalReplayLease,
  type ApprovalReplayStore,
  checkPatchBody,
  checkRoute,
  normalizePath,
  tokenEquals,
  verifyApproval,
} from "./policy.ts";

/**
 * The single-use ledger, connected lazily. Only the ticket path needs it.
 *
 * Not connecting at startup is deliberate: otherwise a database outage would stop the whole
 * broker, reads and creates included. Here the failure is limited to the one delete. It
 * fails closed: if the ledger cannot be used, no ticket passes.
 */
let replayStorePromise: Promise<ApprovalReplayStore> | null = null;
let inMemoryStore: ApprovalReplayGuard | null = null;
function getReplayStore(): Promise<ApprovalReplayStore> {
  // Test-only in-memory ledger, with an interlock: it is used only when
  // `VULTR_REPLAY_DATABASE_URL` is unset. A deployment always sets that URL, so this branch
  // cannot be reached there even if the flag is turned on by mistake. Without it, tests
  // could never exercise a delete that is actually relayed, or a replay refused with 409:
  // with no ledger every ticket gets a 503, so only the refusal would be tested.
  // It is cached separately from the PostgreSQL store on purpose: tests toggle the flag to
  // exercise both paths, and a shared cache would let whichever was created first hide the other.
  if (!process.env.VULTR_REPLAY_DATABASE_URL && process.env.VULTR_APPROVAL_REPLAY_IN_MEMORY === "1") {
    inMemoryStore ??= new ApprovalReplayGuard();
    return Promise.resolve(inMemoryStore);
  }
  if (!replayStorePromise) {
    replayStorePromise = (async () => {
      const url = requireReplayDatabaseUrl(process.env.VULTR_REPLAY_DATABASE_URL);
      const { default: postgres } = await import("postgres");
      const sql = postgres(url);
      const store = new PostgresApprovalReplayStore(fromPostgres(sql));
      await store.initialize();
      return store;
    })().catch((e) => {
      // Clear the cache so the next request tries again; one failure must not block deletes forever.
      replayStorePromise = null;
      throw e;
    });
  }
  return replayStorePromise;
}

const AUTH_TOKEN = process.env.VULTR_BROKER_TOKEN;
const VULTR_KEY = process.env.VULTR_API_KEY;
/** The key that signs delete approval tickets. */
const DELETE_APPROVAL_TOKEN = process.env.VULTR_DELETE_APPROVAL_TOKEN;

// Fail closed: refuse to start if any of these is missing. Started without a key, every call
// would fail upstream and nothing would point at the broker as the cause.
for (const [k, v] of [
  ["VULTR_BROKER_TOKEN", AUTH_TOKEN],
  ["VULTR_API_KEY", VULTR_KEY],
  ["VULTR_DELETE_APPROVAL_TOKEN", DELETE_APPROVAL_TOKEN],
] as const) {
  if (!v) throw new Error(`[vultr-broker] ${k} is not set; refusing to start`);
}

const VULTR_API_BASE = "https://api.vultr.com/v2";

/**
 * Request body limit.
 *
 * The broker does not trust its caller, so having a single caller is no reason to skip a
 * limit. The largest thing sent to Vultr is `user_data` (cloud-init), a few KB; 256 KB is plenty.
 *
 * `Content-Length` is not trusted: it can be missing or wrong, so bytes are counted while reading.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** Upstream timeout. A hanging request would hold a connection in this process. */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Statuses whose responses cannot carry a body; the Fetch `Response` constructor rejects one. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Reads the body up to the limit. Returns null past the limit, and the caller answers 413. */
async function readBodyLimited(req: Request): Promise<string | null> {
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export const app = new Hono();

/**
 * Audit log. Request and response bodies are never logged: the `kvm` field of a Vultr
 * instance carries a console URL with a token in it, and `user_data` carries node report
 * tokens. The log must not become a credential store.
 */
function audit(fields: Record<string, string | number | undefined>): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[vultr-broker] ${parts.join(" ")}`);
}

app.get("/healthz", (c) => c.json({ ok: true, service: "vultr-broker", sha: process.env.BUILD_SHA ?? "unknown" }));

// Every path except /healthz needs the shared token.
app.use("/*", async (c, next) => {
  if (c.req.path === "/healthz") return next();
  if (!tokenEquals(c.req.header("Authorization") ?? "", `Bearer ${AUTH_TOKEN}`)) {
    audit({ verdict: "unauthorized", method: c.req.method, path: c.req.path });
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

/**
 * The relay catch-all: the broker's only function.
 *
 * Path, method and body go to Vultr unchanged, so the caller only swaps the base URL and the
 * auth header; nothing else in the caller changes.
 */
app.all("/*", async (c) => {
  const method = c.req.method;
  const raw = c.req.path + (new URL(c.req.url).search || "");

  // First check: path + method.
  const route = checkRoute(method, raw);
  if (!route.ok) {
    audit({ verdict: "denied", method, path: c.req.path, reason: route.reason });
    return c.json({ error: route.reason }, route.status);
  }

  // The body is a stream and is read once, kept as text to relay as is.
  let bodyText: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const read = await readBodyLimited(c.req.raw);
    if (read === null) {
      audit({ verdict: "denied", method, path: c.req.path, reason: "body too large" });
      return c.json({ error: `request body exceeds the limit of ${MAX_BODY_BYTES} bytes` }, 413);
    }
    bodyText = read;
  }

  // Second check: the body keys of `PATCH /instances/{id}`. The path alone cannot stop a
  // billing change or an OS reinstall.
  if (route.guard === "patch-body") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText ?? "");
    } catch {
      audit({ verdict: "denied", method, path: c.req.path, reason: "invalid json" });
      return c.json({ error: "invalid json body" }, 400);
    }
    const d = checkPatchBody(parsed);
    if (!d.ok) {
      audit({ verdict: "denied", method, path: c.req.path, reason: d.reason });
      return c.json({ error: d.reason }, d.status);
    }
  }

  // Third check: `DELETE /instances/{id}` needs a signed approval ticket, and only that.
  // The old fixed shared token is no longer accepted: keeping it would make the ticket
  // worthless, since anyone with the token could delete as often as they liked.
  //
  // The caller and the broker must therefore move together: a caller that still sends the
  // fixed token cannot delete instances. Roll them back together too.
  let approvalLease: ApprovalReplayLease | null = null;
  if (route.guard === "delete-approval") {
    const approval = c.req.header("X-Delete-Approval") || undefined;
    const instanceId = c.req.path.split("/").pop() as string;
    const nowSec = Math.floor(Date.now() / 1000);
    const v = verifyApproval(approval, DELETE_APPROVAL_TOKEN as string, "instance-destroy", instanceId, nowSec);
    if (!v.ok) {
      audit({ verdict: "denied", method, path: c.req.path, reason: v.reason });
      return c.json({ error: v.reason }, 403);
    }
    let lease: ApprovalReplayLease;
    try {
      lease = await (await getReplayStore()).claim(v.claims, nowSec);
    } catch (e) {
      // No ledger, no pass: a ticket that cannot be held to single use is no better than a fixed token.
      const msg = e instanceof Error ? e.message : String(e);
      audit({ verdict: "denied", method, path: c.req.path, reason: `approval ledger unavailable: ${msg}` });
      return c.json({ error: "delete approval ledger unavailable" }, 503);
    }
    if (!lease.ok) {
      audit({ verdict: "denied", method, path: c.req.path, reason: "approval ticket already used" });
      return c.json({ error: "this delete approval ticket has already been used" }, 409);
    }
    approvalLease = lease;
  }

  // Relay.
  const norm = normalizePath(raw) as { path: string; query: string };
  const target = `${VULTR_API_BASE}${norm.path}${norm.query ? `?${norm.query}` : ""}`;
  let res: Response;
  try {
    res = await fetch(target, {
      // Never wait without a limit: a hanging request holds a connection in this process.
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      method,
      headers: {
        Authorization: `Bearer ${VULTR_KEY}`,
        Accept: "application/json",
        ...(bodyText ? { "Content-Type": "application/json" } : {}),
      },
      ...(bodyText ? { body: bodyText } : {}),
    });
  } catch (e) {
    // The request never reached Vultr: give the ticket back. Otherwise one network error
    // would block deleting that instance until a new ticket is issued (tickets are bound to a target).
    if (approvalLease?.ok) await approvalLease.release();
    const msg = e instanceof Error ? e.message : String(e);
    audit({ verdict: "upstream_error", method, path: c.req.path, reason: msg });
    return c.json({ error: `vultr request failed: ${msg}` }, 502);
  }

  // Consume once a response arrives, whatever its status. Vultr may have accepted the delete
  // even when it answers 5xx; keeping the ticket alive then would open a window for reuse.
  if (approvalLease?.ok) await approvalLease.consume();

  const text = await res.text();
  audit({ verdict: "allowed", method, path: c.req.path, status: res.status });

  // Pass status and body through unchanged, so the caller sees exactly what Vultr returned
  // and its parsing does not change. A 204 from Vultr has an empty body, which is relayed as no body.
  return new Response(NULL_BODY_STATUSES.has(res.status) ? null : text, {
    status: res.status,
    headers: new Headers({ "Content-Type": "application/json" }),
  });
});
