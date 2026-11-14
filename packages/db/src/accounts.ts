/**
 * What a person does with their own account, and what an administrator does
 * for them: one-time invitation and reset links, changing a password, seeing
 * and ending sessions. Tokens are random, shown once, and stored as SHA-256.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { hashPassword, verifyPassword } from "./identity.ts";

const hash = (token: string) => createHash("sha256").update(token).digest();

export type LinkPurpose = "invite" | "reset";

/**
 * Issues a one-time link for a user: `invite` for someone without a password
 * yet, `reset` for someone who has one. Earlier unused links of the user stop
 * working. Returns the token, which is not stored.
 */
export async function issueAccountLink(
  sql: Sql,
  username: string,
  purpose: LinkPurpose,
  createdBy: string,
  hours = 72,
): Promise<
  { token: string; expiresAt: Date } | { error: "unknown-user" | "not-local" | "has-password" | "no-password" }
> {
  return sql.begin(async (tx) => {
    const [user] = await tx<{ id: string; has_password: boolean; oidc: boolean }[]>`
      SELECT id, password_hash IS NOT NULL AS has_password, oidc_issuer IS NOT NULL AS oidc
      FROM users WHERE username = ${username} AND NOT disabled`;
    if (!user) return { error: "unknown-user" } as const;
    if (user.oidc) return { error: "not-local" } as const;
    if (purpose === "invite" && user.has_password) return { error: "has-password" } as const;
    if (purpose === "reset" && !user.has_password) return { error: "no-password" } as const;
    await tx`UPDATE account_links SET used_at = now() WHERE user_id = ${user.id} AND used_at IS NULL`;
    const token = randomBytes(32).toString("base64url");
    const [row] = await tx<{ expires_at: Date }[]>`
      INSERT INTO account_links (token_hash, user_id, purpose, created_by, expires_at)
      VALUES (${hash(token)}, ${user.id}, ${purpose}, ${createdBy}, now() + make_interval(hours => ${hours}))
      RETURNING expires_at`;
    return { token, expiresAt: row?.expires_at ?? new Date() };
  });
}

/**
 * Sets a password through a link, once. Everything that acted as the user
 * before ends (sessions, API tokens), as after any reset.
 */
export async function useAccountLink(
  sql: Sql,
  token: string,
  password: string,
): Promise<{ ok: true; username: string; purpose: LinkPurpose } | { ok: false; reason: "invalid" | "weak" }> {
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch {
    return { ok: false, reason: "weak" };
  }
  return sql.begin(async (tx) => {
    const [link] = await tx<{ user_id: string; purpose: LinkPurpose; username: string }[]>`
      UPDATE account_links l SET used_at = now()
      FROM users u
      WHERE l.token_hash = ${hash(token)} AND l.used_at IS NULL AND l.expires_at > now()
        AND u.id = l.user_id AND NOT u.disabled AND u.oidc_issuer IS NULL
      RETURNING l.user_id, l.purpose, u.username`;
    if (!link) return { ok: false, reason: "invalid" } as const;
    await tx`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${link.user_id}`;
    await tx`DELETE FROM sessions WHERE user_id = ${link.user_id}`;
    await tx`DELETE FROM api_tokens WHERE user_id = ${link.user_id}`;
    await tx`DELETE FROM sign_in_failures WHERE username = ${link.username}`;
    return { ok: true, username: link.username, purpose: link.purpose } as const;
  });
}

/**
 * Changes one's own password after checking the current one. Other sessions
 * and every API token end; the session that asked stays.
 */
export async function changePassword(
  sql: Sql,
  userId: string,
  keepSessionToken: string,
  current: string,
  next: string,
): Promise<{ ok: true } | { ok: false; reason: "wrong-password" | "weak" | "no-password" }> {
  const [user] = await sql<{ password_hash: string | null }[]>`SELECT password_hash FROM users WHERE id = ${userId}`;
  if (!user?.password_hash) return { ok: false, reason: "no-password" };
  if (!(await verifyPassword(current, user.password_hash))) return { ok: false, reason: "wrong-password" };
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(next);
  } catch {
    return { ok: false, reason: "weak" };
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId}`;
    await tx`DELETE FROM sessions WHERE user_id = ${userId} AND token_hash <> ${hash(keepSessionToken)}`;
    await tx`DELETE FROM api_tokens WHERE user_id = ${userId}`;
  });
  return { ok: true };
}

export interface SessionView {
  id: string;
  via: "password" | "oidc";
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** The session that asked. */
  current: boolean;
}

export async function listSessions(sql: Sql, userId: string, currentToken: string): Promise<SessionView[]> {
  const rows = await sql<
    { id: string; via: "password" | "oidc"; created_at: Date; last_seen_at: Date; expires_at: Date; current: boolean }[]
  >`
    SELECT id, via, created_at, last_seen_at, expires_at, token_hash = ${hash(currentToken)} AS current
    FROM sessions WHERE user_id = ${userId} AND expires_at > now() ORDER BY last_seen_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    via: r.via,
    createdAt: r.created_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    current: r.current,
  }));
}

/** Ends one of the user's own sessions. False when it is not theirs or does not exist. */
export async function endSession(sql: Sql, userId: string, sessionId: string): Promise<boolean> {
  const rows = await sql`DELETE FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} RETURNING id`;
  return rows.length === 1;
}

/** Ends every session and API token of a user (an administrator, after a suspected compromise). */
export async function endAllSessions(sql: Sql, username: string): Promise<{ sessions: number; tokens: number } | null> {
  return sql.begin(async (tx) => {
    const [user] = await tx<{ id: string }[]>`SELECT id FROM users WHERE username = ${username}`;
    if (!user) return null;
    const sessions = await tx`DELETE FROM sessions WHERE user_id = ${user.id}`;
    const tokens = await tx`DELETE FROM api_tokens WHERE user_id = ${user.id}`;
    return { sessions: sessions.count, tokens: tokens.count };
  });
}
