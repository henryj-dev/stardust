import type { Client } from "@stardust/sdk";
import { ApiError } from "@stardust/sdk";

/**
 * Proves the sign-in again from a form's `proof` field: six digits are a
 * TOTP code, anything else the password (or a recovery code, which the
 * server also takes as a code). Returns an error message, or null when done.
 */
export async function reauthFrom(client: Client, form: FormData): Promise<string | null> {
  const proof = String(form.get("proof") ?? "").trim();
  if (!proof) return "Enter your password, or a code from your authenticator app.";
  const asCode = /^\d{6}$/.test(proof) || /^[a-z2-7]{5}-[a-z2-7]{5}$/i.test(proof);
  try {
    await client.reauth(asCode ? { code: proof } : { password: proof });
    return null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409)
      return "This session is from single sign-on: sign out and sign in again.";
    if (err instanceof ApiError && err.status < 500) return err.message;
    throw err;
  }
}

/** Whether an API refusal asks to confirm the sign-in first. */
export const needsReauth = (err: unknown) =>
  err instanceof ApiError && err.status === 401 && /confirm it is you/.test(err.message);
