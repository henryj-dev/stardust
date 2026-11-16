/**
 * The broker's delete ticket: `v1.<claims>.<signature>`, the claims as JSON
 * in a fixed key order (other bytes with the same meaning must not verify),
 * signed with HMAC-SHA256 under the key the broker shares. It names one
 * instance and who approved, lives five minutes at most, and the broker
 * accepts each `jti` once.
 */
import { createHmac, randomUUID } from "node:crypto";

export interface ApprovalClaims {
  v: 1;
  purpose: "instance-destroy";
  target: string;
  actor: string;
  jti: string;
  iat: number;
  exp: number;
}

const TTL_SECONDS = 120;

export function approvalClaims(target: string, actor: string, nowMs: number): ApprovalClaims {
  const iat = Math.floor(nowMs / 1000);
  return { v: 1, purpose: "instance-destroy", target, actor, jti: randomUUID(), iat, exp: iat + TTL_SECONDS };
}

const canonical = (c: ApprovalClaims) =>
  JSON.stringify({ actor: c.actor, exp: c.exp, iat: c.iat, jti: c.jti, purpose: c.purpose, target: c.target, v: c.v });

export function signApproval(claims: ApprovalClaims, key: string): string {
  const input = `v1.${Buffer.from(canonical(claims)).toString("base64url")}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}
