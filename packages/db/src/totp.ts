/**
 * Two-step sign-in for local accounts, and re-authentication. The TOTP
 * secret is sealed with AES-256-GCM when a key is configured. A code is
 * accepted once: the last used step only moves forward, in one UPDATE.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { newRecoveryCodes, newTotpSecret, recoveryCodeHash, totpUri, verifyTotp } from "@stardust/core";
import type { Sql } from "postgres";

const hash = (token: string) => createHash("sha256").update(token).digest();

function seal(plain: string, key: string | undefined): string {
  if (!key) return `plain:${plain}`;
  const k = createHash("sha256").update(key).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${body.toString("base64url")}`;
}

function unseal(stored: string, key: string | undefined): string {
  if (stored.startsWith("plain:")) return stored.slice(6);
  const [version, iv, tag, body] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("unknown TOTP secret format");
  if (!key) throw new Error("this TOTP secret is sealed: auth.local.totpKey is needed");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(key).digest(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export interface TotpStatus {
  enrolled: boolean;
  /** Set up but not confirmed with a first code. */
  pending: boolean;
  recoveryCodesLeft: number;
}

export async function totpStatus(sql: Sql, userId: string): Promise<TotpStatus> {
  const [row] = await sql<{ confirmed: boolean | null; left: number }[]>`
    SELECT (SELECT confirmed_at IS NOT NULL FROM user_totp WHERE user_id = ${userId}) AS confirmed,
           (SELECT count(*)::int FROM user_recovery_codes WHERE user_id = ${userId} AND used_at IS NULL) AS left`;
  return { enrolled: row?.confirmed === true, pending: row?.confirmed === false, recoveryCodesLeft: row?.left ?? 0 };
}

/** Starts (or restarts) setting up TOTP: a new secret, not yet in use. Refused while one is confirmed. */
export async function beginTotp(
  sql: Sql,
  userId: string,
  account: string,
  issuer: string,
  key: string | undefined,
): Promise<{ secret: string; uri: string } | null> {
  const secret = newTotpSecret();
  const rows = await sql`
    INSERT INTO user_totp (user_id, secret) VALUES (${userId}, ${seal(secret, key)})
    ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, last_step = NULL
      WHERE user_totp.confirmed_at IS NULL
    RETURNING user_id`;
  if (rows.length === 0) return null;
  return { secret, uri: totpUri(secret, issuer, account) };
}

/** Confirms the pending secret with a first code; returns new recovery codes, shown once. */
export async function confirmTotp(
  sql: Sql,
  userId: string,
  code: string,
  key: string | undefined,
  now = new Date(),
): Promise<string[] | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ secret: string }[]>`
      SELECT secret FROM user_totp WHERE user_id = ${userId} AND confirmed_at IS NULL FOR UPDATE`;
    if (!row) return null;
    const step = verifyTotp(unseal(row.secret, key), code, now, null);
    if (step === null) return null;
    await tx`UPDATE user_totp SET confirmed_at = now(), last_step = ${step} WHERE user_id = ${userId}`;
    return replaceRecoveryCodes(tx as unknown as Sql, userId);
  });
}

async function replaceRecoveryCodes(sql: Sql, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await sql`DELETE FROM user_recovery_codes WHERE user_id = ${userId}`;
  for (const code of codes) {
    await sql`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (${userId}, ${recoveryCodeHash(code)})`;
  }
  return codes;
}

/**
 * Checks a second factor: a TOTP code (each step once) or an unused
 * recovery code (used up here). False when neither matches.
 */
export async function checkSecondFactor(
  sql: Sql,
  userId: string,
  code: string,
  key: string | undefined,
  now = new Date(),
): Promise<"totp" | "recovery" | null> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const [row] = await sql<{ secret: string; last_step: string | null }[]>`
      SELECT secret, last_step FROM user_totp WHERE user_id = ${userId} AND confirmed_at IS NOT NULL`;
    if (!row) return null;
    const step = verifyTotp(
      unseal(row.secret, key),
      trimmed,
      now,
      row.last_step === null ? null : Number(row.last_step),
    );
    if (step === null) return null;
    // Only moves forward: a code raced from two places is accepted once.
    const moved = await sql`
      UPDATE user_totp SET last_step = ${step}
      WHERE user_id = ${userId} AND (last_step IS NULL OR last_step < ${step}) RETURNING user_id`;
    return moved.length === 1 ? "totp" : null;
  }
  const used = await sql`
    UPDATE user_recovery_codes SET used_at = now()
    WHERE user_id = ${userId} AND code_hash = ${recoveryCodeHash(trimmed)} AND used_at IS NULL RETURNING user_id`;
  return used.length === 1 ? "recovery" : null;
}

export async function newRecoveryCodesFor(sql: Sql, userId: string): Promise<string[]> {
  return sql.begin((tx) => replaceRecoveryCodes(tx as unknown as Sql, userId));
}

/** Turns TOTP off for a user (themselves, or an administrator after a lost phone). */
export async function removeTotp(sql: Sql, userId: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx`DELETE FROM user_totp WHERE user_id = ${userId} RETURNING user_id`;
    await tx`DELETE FROM user_recovery_codes WHERE user_id = ${userId}`;
    return rows.length === 1;
  });
}

/** After the password: a challenge that must be answered with a code within five minutes, five tries. */
export async function startChallenge(sql: Sql, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`DELETE FROM sign_in_challenges WHERE expires_at < now()`;
  await sql`
    INSERT INTO sign_in_challenges (token_hash, user_id, expires_at)
    VALUES (${hash(token)}, ${userId}, now() + interval '5 minutes')`;
  return token;
}

/** The user a live challenge belongs to, counting the try; null when it is gone or used up. */
export async function takeChallengeTry(sql: Sql, challenge: string): Promise<string | null> {
  const [row] = await sql<{ user_id: string }[]>`
    UPDATE sign_in_challenges SET attempts = attempts + 1
    WHERE token_hash = ${hash(challenge)} AND expires_at > now() AND attempts < 5
    RETURNING user_id`;
  return row?.user_id ?? null;
}

export async function endChallenge(sql: Sql, challenge: string): Promise<void> {
  await sql`DELETE FROM sign_in_challenges WHERE token_hash = ${hash(challenge)}`;
}

/** Records that the session proved its sign-in again now. */
export async function markReauthenticated(sql: Sql, sessionToken: string): Promise<void> {
  await sql`UPDATE sessions SET reauth_at = now() WHERE token_hash = ${hash(sessionToken)}`;
}

/** How a session was started and how many seconds ago it last proved its sign-in; null when it is not a session. */
export async function sessionFreshness(
  sql: Sql,
  sessionToken: string,
): Promise<{ via: "password" | "oidc"; ageSeconds: number } | null> {
  const [row] = await sql<{ via: "password" | "oidc"; age: number }[]>`
    SELECT via, extract(epoch FROM now() - coalesce(reauth_at, created_at))::int AS age
    FROM sessions WHERE token_hash = ${hash(sessionToken)} AND expires_at > now()`;
  return row ? { via: row.via, ageSeconds: row.age } : null;
}
