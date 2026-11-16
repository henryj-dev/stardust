/**
 * The database side of OpenID Connect sign-in: pending logins that can be
 * taken once, and the mapping from a provider's (issuer, subject) to a user.
 *
 * An identity is matched by issuer and subject only — never by username or
 * email, which the provider's users may be able to choose. A new identity
 * whose username is already taken is refused rather than linked to that
 * account, so nobody signs in to someone else's password account.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type { User } from "./identity.ts";

export interface PendingLoginRow {
  state: string;
  nonce: string;
  codeVerifier: string;
  reauth?: boolean;
}

const PENDING_MINUTES = 10;

export async function savePendingLogin(sql: Sql, p: PendingLoginRow): Promise<void> {
  await sql`DELETE FROM oidc_logins WHERE created_at < now() - make_interval(mins => ${PENDING_MINUTES})`;
  await sql`
    INSERT INTO oidc_logins (state, nonce, code_verifier, reauth)
    VALUES (${p.state}, ${p.nonce}, ${p.codeVerifier}, ${p.reauth === true})`;
}

/** Removes and returns the pending login, or null when unknown, used or expired. */
export async function takePendingLogin(sql: Sql, state: string): Promise<PendingLoginRow | null> {
  const [row] = await sql<{ state: string; nonce: string; code_verifier: string; reauth: boolean; fresh: boolean }[]>`
    DELETE FROM oidc_logins WHERE state = ${state}
    RETURNING state, nonce, code_verifier, reauth,
              created_at > now() - make_interval(mins => ${PENDING_MINUTES}) AS fresh`;
  if (!row?.fresh) return null;
  return {
    state: row.state,
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    ...(row.reauth ? { reauth: true } : {}),
  };
}

export interface ExternalIdentity {
  issuer: string;
  subject: string;
  username: string | null;
  name: string | null;
}

export type IdentitySignIn =
  | { ok: true; token: string; user: User; created: boolean }
  | { ok: false; reason: "no-account" | "disabled" | "username-taken" | "no-username" };

/** Lower-case, and anything not allowed in a username becomes "-". */
export function usernameFrom(raw: string): string | null {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
  return name === "" ? null : name;
}

export async function signInWithIdentity(
  sql: Sql,
  identity: ExternalIdentity,
  options: {
    autoCreate: boolean;
    isAdmin: boolean | null;
    sessionHours?: number;
    /** The provider's session id and ID token, for logging out there and from there. */
    sid?: string | null;
    idToken?: string;
  },
): Promise<IdentitySignIn> {
  type Row = { id: string; username: string; display_name: string; is_admin: boolean; disabled: boolean };
  let [row] = await sql<Row[]>`
    SELECT id, username, display_name, is_admin, disabled FROM users
    WHERE oidc_issuer = ${identity.issuer} AND oidc_subject = ${identity.subject}`;
  let created = false;
  if (!row) {
    if (!options.autoCreate) return { ok: false, reason: "no-account" };
    const username = identity.username ? usernameFrom(identity.username) : null;
    if (!username) return { ok: false, reason: "no-username" };
    const inserted = await sql<Row[]>`
      INSERT INTO users (username, display_name, oidc_issuer, oidc_subject, is_admin)
      VALUES (${username}, ${identity.name ?? ""}, ${identity.issuer}, ${identity.subject}, ${options.isAdmin ?? false})
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username, display_name, is_admin, disabled`;
    row = inserted[0];
    if (!row) return { ok: false, reason: "username-taken" };
    created = true;
  }
  if (row.disabled) return { ok: false, reason: "disabled" };
  // Group-based administration follows the provider at every sign-in.
  if (options.isAdmin !== null && row.is_admin !== options.isAdmin) {
    await sql`UPDATE users SET is_admin = ${options.isAdmin} WHERE id = ${row.id}`;
    row = { ...row, is_admin: options.isAdmin };
  }
  const token = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at, via, oidc_sid, oidc_id_token)
    VALUES (${row.id}, ${createHash("sha256").update(token).digest()},
            now() + make_interval(hours => ${options.sessionHours ?? 12}), 'oidc',
            ${options.sid ?? null}, ${options.idToken ?? null})`;
  return {
    ok: true,
    token,
    created,
    user: { id: row.id, username: row.username, displayName: row.display_name, isAdmin: row.is_admin },
  };
}

/**
 * Ends single sign-on sessions the provider says have ended: the provider
 * session `sid`, or every session of the subject. Returns how many ended.
 */
export async function endOidcSessions(
  sql: Sql,
  issuer: string,
  notice: { subject: string | null; sid: string | null },
): Promise<number> {
  const rows = await sql`
    DELETE FROM sessions s USING users u
    WHERE s.user_id = u.id AND s.via = 'oidc' AND u.oidc_issuer = ${issuer}
      AND (${notice.sid === null ? sql`false` : sql`s.oidc_sid = ${notice.sid}`}
           OR ${notice.subject === null ? sql`false` : sql`u.oidc_subject = ${notice.subject}`})
    RETURNING s.id`;
  return rows.length;
}

/** The ID token a session was started with, to name it when signing out at the provider. */
export async function oidcLogoutHint(sql: Sql, sessionToken: string): Promise<string | null> {
  const [row] = await sql<{ id_token: string | null }[]>`
    SELECT oidc_id_token AS id_token FROM sessions
    WHERE token_hash = ${createHash("sha256").update(sessionToken).digest()} AND via = 'oidc'`;
  return row?.id_token ?? null;
}
