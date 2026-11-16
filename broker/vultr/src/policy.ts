import { createHmac, timingSafeEqual } from "node:crypto";

// The broker's policy. This module is pure: no network, no clock (the caller passes `now`),
// no state except the in-process replay guard at the bottom.
//
// This file is the whole broker. `index.ts` only asks the policy and relays what passes, so
// every security property is decided and tested here.
//
// Three layers of checks:
//   1. An allowlist of path + method. Account, billing, user and snapshot endpoints are not on it.
//   2. An allowlist of body keys for `PATCH /instances/{id}`. The path alone cannot stop a
//      plan change or an OS reinstall.
//   3. `DELETE /instances/{id}` needs a signed, single-use approval ticket.
//
// There is deliberately no "rollback ticket" that would let an instance-create saga delete
// its own half-built instance without approval. The caller's saga has no automatic rollback:
// a failed create is recorded as failed and the instance is left for a person to clean up.
// A rollback ticket would have no user, and it would leave open a way to delete instances
// that no person approved. The broker is trusted because it is small enough to audit, and
// an unused bypass works against that. Revisit this if automatic rollback is ever added.

/** Vultr instance, VPC and firewall group ids are UUIDs. */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** Firewall rule ids are integers. */
const RULE_ID = "[0-9]{1,10}";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface Rule {
  method: Method;
  /** Must match the whole path (anchored). The query string is split off before matching. */
  path: RegExp;
  /** Set when a request that matches the rule still needs another check. */
  guard?: "patch-body" | "delete-approval";
}

/**
 * The allowlist: exactly the Vultr endpoints the caller uses.
 *
 * No prefix matching: opening `/instances/{id}` as a prefix would also open
 * `/instances/{id}/anything` (such as `/halt` or `/reinstall`). Every entry is anchored with
 * `^...$`, and new entries must be too.
 */
export const ALLOW: readonly Rule[] = [
  // Reads. Limited to this list, not every GET.
  { method: "GET", path: /^\/instances$/ },
  { method: "GET", path: new RegExp(`^/instances/${UUID}$`) },
  { method: "GET", path: new RegExp(`^/instances/${UUID}/vpcs$`) },
  { method: "GET", path: /^\/vpcs$/ },
  { method: "GET", path: new RegExp(`^/vpcs/${UUID}$`) },
  { method: "GET", path: /^\/firewalls$/ },
  { method: "GET", path: new RegExp(`^/firewalls/${UUID}$`) },
  { method: "GET", path: new RegExp(`^/firewalls/${UUID}/rules$`) },
  { method: "GET", path: /^\/ssh-keys$/ },
  { method: "GET", path: /^\/os$/ },
  { method: "GET", path: /^\/plans$/ },
  // Lets the create form offer a region. Like `/os` and `/plans`, this is a public catalog
  // that does not depend on the account. Without it the region list comes back empty, and
  // an empty list cannot be told apart from a failed read.
  { method: "GET", path: /^\/regions$/ },

  // Writes.
  { method: "POST", path: /^\/instances$/ },
  // The path alone would also allow billing changes and OS reinstalls: the body keys are checked.
  { method: "PATCH", path: new RegExp(`^/instances/${UUID}$`), guard: "patch-body" },
  // Needs a signed approval ticket.
  { method: "DELETE", path: new RegExp(`^/instances/${UUID}$`), guard: "delete-approval" },
  { method: "POST", path: new RegExp(`^/instances/${UUID}/ipv4/reverse$`) },
  { method: "POST", path: new RegExp(`^/instances/${UUID}/ipv6/reverse$`) },
  { method: "POST", path: /^\/firewalls$/ },
  { method: "DELETE", path: new RegExp(`^/firewalls/${UUID}$`) },
  { method: "POST", path: new RegExp(`^/firewalls/${UUID}/rules$`) },
  { method: "DELETE", path: new RegExp(`^/firewalls/${UUID}/rules/${RULE_ID}$`) },
];

/**
 * The body keys allowed on `PATCH /instances/{id}`.
 *
 * Vultr's endpoint also accepts `backups` (billing), `os_id`, `app_id` and `image_id` (an OS
 * reinstall, which destroys the disk), `detach_vpc` (cuts the instance off the private
 * network) and `user_scheme`. All of those stay blocked.
 *
 * `plan` is allowed so instances can be resized, but only together with a check on its
 * value (`PATCH_PLAN_ALLOW`). Allowing the key alone would allow any billing change, not a
 * resize. Keeping the key list and the value list in this one file shows exactly what is open.
 */
export const PATCH_INSTANCE_KEYS: readonly string[] = ["user_data", "firewall_group_id", "plan"];

/**
 * The values allowed for `plan`. Anything else is a 403 and is logged as denied.
 *
 * An explicit list rather than a pattern such as `^vc2-\d+c-\d+gb$`: a pattern accepts new
 * plans automatically, and the broker does not know prices. If Vultr changed its naming or
 * released an expensive family in the same format, a pattern would let it through quietly.
 * A list fails loudly instead: a new plan is refused until someone adds it here. The broker
 * is trusted because it is small enough to audit, so failing loudly is the right default.
 *
 * Each entry raises the billing ceiling. Get the operator's approval before adding one.
 */
export const PATCH_PLAN_ALLOW: readonly string[] = ["vc2-1c-1gb", "vc2-1c-2gb", "vc2-2c-4gb", "vc2-4c-8gb"];

export type Decision = { ok: true; guard?: Rule["guard"] } | { ok: false; status: 400 | 403; reason: string };

/** Splits the path from the query and checks its shape. Returns the path to match against the allowlist. */
export function normalizePath(raw: string): { path: string; query: string } | null {
  if (!raw.startsWith("/")) return null;
  const qIdx = raw.indexOf("?");
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const query = qIdx >= 0 ? raw.slice(qIdx + 1) : "";
  // Refuse traversal and encoded separators in the path. The allowlist patterns already
  // reject dots, but refusing here, before matching, records the intent in the log.
  if (path.includes("..") || path.includes("//")) return null;
  if (/%2e/i.test(path) || /%2f/i.test(path)) return null;
  // No whitespace or control characters.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (/[\s\x00-\x1f]/.test(path)) return null;
  return { path, query };
}

/** First check: path + method. When a guard is returned, the caller must run that check too. */
export function checkRoute(method: string, rawPath: string): Decision {
  const norm = normalizePath(rawPath);
  if (!norm) return { ok: false, status: 400, reason: "malformed path" };
  const m = ALLOW.find((r) => r.method === method && r.path.test(norm.path));
  if (!m) return { ok: false, status: 403, reason: `not allowed: ${method} ${norm.path}` };
  return { ok: true, guard: m.guard };
}

/** Second check: the body keys of `PATCH /instances/{id}`. */
export function checkPatchBody(body: unknown): Decision {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, reason: "body must be an object" };
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length === 0) return { ok: false, status: 400, reason: "empty body" };
  // Reject, do not filter. Silently dropping a key would make the caller believe it was applied.
  const bad = keys.filter((k) => !PATCH_INSTANCE_KEYS.includes(k));
  if (bad.length > 0) {
    return {
      ok: false,
      status: 400,
      reason: `PATCH /instances does not allow: ${bad.sort().join(", ")} (allowed: ${PATCH_INSTANCE_KEYS.join(", ")})`,
    };
  }
  // A `plan` key that passed is still checked by value: this is the billing ceiling.
  // 403, not 400: the request is well formed but not permitted. A 400 would suggest that
  // fixing the body would make it pass.
  if ("plan" in (body as Record<string, unknown>)) {
    const plan = (body as Record<string, unknown>).plan;
    if (typeof plan !== "string" || !PATCH_PLAN_ALLOW.includes(plan)) {
      return {
        ok: false,
        status: 403,
        reason: `plan not allowed: ${typeof plan === "string" ? plan : typeof plan} (allowed: ${PATCH_PLAN_ALLOW.join(", ")})`,
      };
    }
  }
  return { ok: true };
}

/** Constant-time string comparison, so timing does not reveal the token. */
export function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Third check: approval for `DELETE /instances/{id}`.
//
// A single-use signed ticket is the only way through. An earlier fixed shared token was
// removed: while both were accepted the ticket added nothing, because anyone holding the
// token could still delete as often as they liked.
//
// A ticket narrows all three of the fixed token's weaknesses: it is bound to one target,
// lives at most five minutes, and its `jti` can be used once.
//
// The only purpose is `instance-destroy`. The replay table's CHECK constraint also admits
// `create-rollback`, but allowing it there is not a reason to issue it; see the note at the
// top of this file.
//
// Tickets are signed with `VULTR_DELETE_APPROVAL_TOKEN`, so no extra secret is needed. Only
// whoever holds that token can issue tickets, and today that is only the caller.

export type ApprovalPurpose = "instance-destroy";

export type ApprovalClaims = {
  v: 1;
  purpose: ApprovalPurpose;
  target: string;
  actor: string;
  jti: string;
  iat: number;
  exp: number;
};

/** What is signed is a serialization with a fixed key order: different bytes with the same meaning must not pass. */
function canonicalClaims(claims: ApprovalClaims): string {
  return JSON.stringify({
    actor: claims.actor,
    exp: claims.exp,
    iat: claims.iat,
    jti: claims.jti,
    purpose: claims.purpose,
    target: claims.target,
    v: claims.v,
  });
}

export function signApproval(claims: ApprovalClaims, key: string): string {
  const payload = Buffer.from(canonicalClaims(claims)).toString("base64url");
  const input = `v1.${payload}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

/** Whether a token has the shape of a ticket. Used to branch, not to decide. */
export function looksLikeApprovalTicket(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts[0] === "v1";
}

export function verifyApproval(
  token: string | undefined,
  key: string,
  expectedPurpose: ApprovalPurpose,
  expectedTarget: string,
  now: number,
): { ok: true; claims: ApprovalClaims } | { ok: false; reason: string } {
  if (!token) return { ok: false, reason: "signed delete approval header missing" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "approval format invalid" };
  let claims: ApprovalClaims;
  let decoded: string;
  try {
    const bytes = Buffer.from(parts[1] as string, "base64url");
    // base64url can spell the same bytes more than one way: the round trip must give back the original.
    if (bytes.toString("base64url") !== (parts[1] as string)) throw new Error("non-canonical base64url");
    decoded = bytes.toString("utf8");
    claims = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "approval payload invalid" };
  }
  if (!claims || typeof claims !== "object" || canonicalClaims(claims) !== decoded) {
    return { ok: false, reason: "approval claims not canonical" };
  }
  const expected = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const supplied = Buffer.from(parts[2] as string, "base64url");
  if (
    supplied.toString("base64url") !== (parts[2] as string) ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return { ok: false, reason: "approval signature invalid" };
  }
  const maxTtl = 300;
  if (
    claims.v !== 1 ||
    claims.purpose !== expectedPurpose ||
    typeof claims.target !== "string" ||
    !new RegExp(`^${UUID}$`).test(claims.target) ||
    claims.target.toLowerCase() !== expectedTarget.toLowerCase() ||
    typeof claims.actor !== "string" ||
    claims.actor.length < 1 ||
    typeof claims.jti !== "string" ||
    !new RegExp(`^${UUID}$`).test(claims.jti) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= now ||
    claims.iat > now + 60 ||
    claims.iat < now - maxTtl - 60 ||
    claims.exp - claims.iat <= 0 ||
    claims.exp - claims.iat > maxTtl
  ) {
    return { ok: false, reason: "approval claims invalid, expired, or wrong target/purpose" };
  }
  return { ok: true, claims };
}

export type ApprovalReplayLease =
  | { ok: true; consume: () => void | Promise<void>; release: () => void | Promise<void> }
  | { ok: false };

export interface ApprovalReplayStore {
  claim(claims: ApprovalClaims, now: number): ApprovalReplayLease | Promise<ApprovalReplayLease>;
}

/**
 * In-process replay guard, for tests and local runs only.
 * A real deployment must use the durable PostgreSQL ledger (`approval-replay-store.ts`):
 * with several replicas, or after a restart, this map would accept the same ticket twice.
 */
export class ApprovalReplayGuard implements ApprovalReplayStore {
  private entries = new Map<string, { exp: number; state: "claimed" | "consumed" }>();
  private readonly maxEntries: number;
  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }
  claim(claims: ApprovalClaims, now: number): ApprovalReplayLease {
    const { jti, exp } = claims;
    for (const [id, entry] of this.entries) if (entry.exp <= now) this.entries.delete(id);
    if (this.entries.has(jti) || this.entries.size >= this.maxEntries) return { ok: false };
    const entry: { exp: number; state: "claimed" | "consumed" } = { exp, state: "claimed" };
    this.entries.set(jti, entry);
    return {
      ok: true,
      consume: () => {
        entry.state = "consumed";
      },
      // If the relay fails, the ticket is given back. Otherwise one network error would make
      // the delete impossible until a new ticket is issued.
      release: () => {
        if (entry.state === "claimed") this.entries.delete(jti);
      },
    };
  }
}
