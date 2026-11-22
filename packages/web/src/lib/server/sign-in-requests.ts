import type { AuditEventView, UserView } from "@stardust/sdk";

/** Someone the provider vouched for who has no account here yet, from the audit log. */
export interface SignInRequest {
  subject: string;
  issuer: string | null;
  /** Why they were turned away: no account, or their username belongs to another one. */
  reason: "no-account" | "username-taken";
  /** What the provider said about them; any of it may be missing. */
  username: string | null;
  email: string | null;
  name: string | null;
  /** The newest attempt, and how many there were in what was read. */
  at: string;
  attempts: number;
}

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

/**
 * The single sign-on attempts turned away for want of an account, one per
 * person, newest first, leaving out anyone an account now carries. `events`
 * is a page of `auth.login.failed`.
 */
export function signInRequests(events: readonly AuditEventView[], users: readonly UserView[]): SignInRequest[] {
  const linked = new Set(users.flatMap((u) => (u.oidc ? [`${u.oidc.issuer} ${u.oidc.subject}`, u.oidc.subject] : [])));
  const byPerson = new Map<string, SignInRequest>();
  for (const e of events) {
    const d = e.detail;
    if (e.action !== "auth.login.failed" || d.via !== "oidc") continue;
    if (d.reason !== "no-account" && d.reason !== "username-taken") continue;
    const subject = e.target;
    if (!subject) continue;
    const issuer = text(d.issuer);
    if (linked.has(issuer ? `${issuer} ${subject}` : subject)) continue;
    const key = `${issuer ?? ""} ${subject}`;
    const seen = byPerson.get(key);
    if (seen) {
      seen.attempts += 1;
      continue;
    }
    const claimed = (d.claimed ?? {}) as Record<string, unknown>;
    byPerson.set(key, {
      subject,
      issuer,
      reason: d.reason,
      username: text(claimed.username),
      email: text(claimed.email),
      name: text(claimed.name),
      at: e.at,
      attempts: 1,
    });
  }
  return [...byPerson.values()].sort((a, b) => b.at.localeCompare(a.at));
}
