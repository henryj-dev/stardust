/**
 * Accounts and sessions.
 *
 * - Passwords are scrypt hashes with a per-user salt.
 * - Session tokens are random and shown once; only their SHA-256 is stored.
 * - A username with too many recent failures is locked for the window.
 * - Signing in as a user who does not exist costs the same scrypt work as a
 *   wrong password, so response time does not reveal which usernames exist.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ProjectRole } from "@stardust/core";
import type { Sql } from "postgres";

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}
const SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 32 };
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

function derive(password: string, salt: Buffer, params: ScryptParams = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
      (e, k) => (e ? reject(e) : resolve(k)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("passwords must be at least 12 characters");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A hash nobody knows the password to, verified when the user does not exist.
let dummyHash: Promise<string> | null = null;
const dummy = () => {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return dummyHash;
};

const tokenHash = (token: string) => createHash("sha256").update(token).digest();

export async function createUser(
  sql: Sql,
  input: { username: string; password?: string; isAdmin?: boolean; displayName?: string },
): Promise<User> {
  if (!USERNAME.test(input.username)) throw new Error(`username "${input.username}" is not allowed`);
  const hash = input.password === undefined ? null : await hashPassword(input.password);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (username, display_name, password_hash, is_admin)
    VALUES (${input.username}, ${input.displayName ?? ""}, ${hash}, ${input.isAdmin ?? false})
    RETURNING id`;
  if (!row) throw new Error("user insert returned no row");
  return {
    id: row.id,
    username: input.username,
    displayName: input.displayName ?? "",
    isAdmin: input.isAdmin ?? false,
  };
}

/** Creates the first administrator, once: does nothing when any user exists. */
export async function ensureBootstrapAdmin(sql: Sql, username: string, password: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('stardust:bootstrap-admin'))`;
    const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
    if ((row?.n ?? 0) > 0) return false;
    if (!USERNAME.test(username)) throw new Error(`username "${username}" is not allowed`);
    await tx`INSERT INTO users (username, password_hash, is_admin) VALUES (${username}, ${await hashPassword(password)}, true)`;
    return true;
  });
}

export interface SignInPolicy {
  maxFailures: number;
  windowMinutes: number;
  sessionHours: number;
}
export const DEFAULT_SIGN_IN: SignInPolicy = { maxFailures: 10, windowMinutes: 15, sessionHours: 12 };

export type SignInResult = { ok: true; token: string; user: User } | { ok: false; reason: "invalid" | "locked" };

export async function signIn(
  sql: Sql,
  username: string,
  password: string,
  policy: SignInPolicy = DEFAULT_SIGN_IN,
): Promise<SignInResult> {
  const [failures] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM sign_in_failures
    WHERE username = ${username} AND failed_at > now() - make_interval(mins => ${policy.windowMinutes})`;
  if ((failures?.n ?? 0) >= policy.maxFailures) return { ok: false, reason: "locked" };

  const [row] = await sql<
    {
      id: string;
      username: string;
      display_name: string;
      password_hash: string | null;
      is_admin: boolean;
      disabled: boolean;
    }[]
  >`
    SELECT id, username, display_name, password_hash, is_admin, disabled FROM users WHERE username = ${username}`;
  const valid = await verifyPassword(password, row?.password_hash ?? (await dummy()));
  if (!row || !valid || row.disabled || row.password_hash === null) {
    await sql`INSERT INTO sign_in_failures (username) VALUES (${username})`;
    return { ok: false, reason: "invalid" };
  }
  await sql`DELETE FROM sign_in_failures WHERE username = ${username}`;
  const token = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${row.id}, ${tokenHash(token)}, now() + make_interval(hours => ${policy.sessionHours}))`;
  return {
    ok: true,
    token,
    user: { id: row.id, username: row.username, displayName: row.display_name, isAdmin: row.is_admin },
  };
}

/** The user a session token belongs to, or null when it is unknown, expired or the user is disabled. */
export async function authenticate(sql: Sql, token: string): Promise<User | null> {
  if (!token) return null;
  const [row] = await sql<{ session: string; id: string; username: string; display_name: string; is_admin: boolean }[]>`
    SELECT s.id AS session, u.id, u.username, u.display_name, u.is_admin
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash(token)} AND s.expires_at > now() AND NOT u.disabled`;
  if (!row) return null;
  await sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${row.session} AND last_seen_at < now() - interval '1 minute'`;
  return { id: row.id, username: row.username, displayName: row.display_name, isAdmin: row.is_admin };
}

export async function signOut(sql: Sql, token: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash(token)}`;
}

export async function projectRole(sql: Sql, userId: string, projectId: string): Promise<ProjectRole | null> {
  const [row] = await sql<{ role: ProjectRole }[]>`
    SELECT role FROM project_members WHERE user_id = ${userId} AND project_id = ${projectId}`;
  return row?.role ?? null;
}

export async function setProjectRole(
  sql: Sql,
  projectId: string,
  userId: string,
  role: ProjectRole | null,
): Promise<void> {
  if (role === null) {
    await sql`DELETE FROM project_members WHERE project_id = ${projectId} AND user_id = ${userId}`;
    return;
  }
  await sql`
    INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${userId}, ${role})
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`;
}
