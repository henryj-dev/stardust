/**
 * Guards for actions that cannot be taken back: an approval ticket bound to
 * one action on one target, valid briefly and once; targets that may never be
 * destroyed; and a rate rule for revealing secrets. The decisions are here;
 * what must be remembered (a used ticket, recent reveals) is kept through the
 * `guards` port.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The `guards` port: small, durable memory for the guards. */
export interface GuardStore {
  /** True the first time `id` is used in `scope`; false every time after. Forgets it after `expiresAt`. */
  useOnce(scope: string, id: string, expiresAt: Date): Promise<boolean>;
  /** Records one event for `key` in `scope` and returns how many there were in the last `windowMs`, this one included. */
  count(scope: string, key: string, windowMs: number): Promise<number>;
}

export interface ApprovalClaim {
  /** What is approved, e.g. `instances.destroy`. */
  action: string;
  /** Exactly what it is approved on, e.g. an instance id. */
  target: string;
}

export type ApprovalCheck =
  | { ok: true; ticketId: string; expiresAt: Date }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "mismatch" | "used" };

const b64 = (b: Buffer) => b.toString("base64url");
const sign = (key: string, payload: string) => createHmac("sha256", key).update(payload).digest();

/** Issues a ticket approving one action on one target, valid for `ttlMs`. */
export function issueApproval(key: string, claim: ApprovalClaim, ttlMs: number, now = new Date()): string {
  if (key.length < 32) throw new Error("the approval key must be at least 32 characters");
  const payload = b64(
    Buffer.from(
      JSON.stringify({ a: claim.action, t: claim.target, exp: now.getTime() + ttlMs, jti: b64(randomBytes(16)) }),
    ),
  );
  return `${payload}.${b64(sign(key, payload))}`;
}

/**
 * Checks a ticket for this action on this target and uses it up. A ticket
 * passes once: the second check of the same ticket is `used`.
 */
export async function checkApproval(
  key: string,
  ticket: string,
  claim: ApprovalClaim,
  store: GuardStore,
  now = new Date(),
): Promise<ApprovalCheck> {
  const [payload, signature, ...rest] = ticket.split(".");
  if (!payload || !signature || rest.length > 0) return { ok: false, reason: "malformed" };
  const expected = sign(key, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "signature" };
  let body: { a?: unknown; t?: unknown; exp?: unknown; jti?: unknown };
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof body.exp !== "number" || typeof body.jti !== "string") return { ok: false, reason: "malformed" };
  if (body.exp <= now.getTime()) return { ok: false, reason: "expired" };
  if (body.a !== claim.action || body.t !== claim.target) return { ok: false, reason: "mismatch" };
  const expiresAt = new Date(body.exp);
  if (!(await store.useOnce("approval", body.jti, expiresAt))) return { ok: false, reason: "used" };
  return { ok: true, ticketId: body.jti, expiresAt };
}

export interface ProtectedTargets {
  /** Names starting with one of these are protected, e.g. `gw-`. */
  prefixes?: readonly string[];
  /** Exact names or addresses. */
  exact?: readonly string[];
}

/** Whether a target may never be destroyed. Matching ignores case. */
export function isProtected(target: string, rules: ProtectedTargets): boolean {
  const name = target.toLowerCase();
  return (
    (rules.prefixes ?? []).some((p) => name.startsWith(p.toLowerCase())) ||
    (rules.exact ?? []).some((e) => name === e.toLowerCase())
  );
}

export interface RevealRule {
  /** Reveals one person may make per minute. */
  perMinute: number;
}

/** Records a reveal by `userId` and says whether it is within the rule. */
export async function allowReveal(store: GuardStore, userId: string, rule: RevealRule): Promise<boolean> {
  return (await store.count("reveal", userId, 60_000)) <= rule.perMinute;
}
