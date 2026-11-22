/**
 * Sign-in settings administrators change on the dashboard. Each is null until
 * set, and then the configuration's value applies; once set it takes
 * precedence over the configuration until it is cleared again.
 */
import type { Sql } from "postgres";

export interface SignInSettings {
  /** Create an account at a first single sign-on; null follows the configuration. */
  autoCreate: boolean | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export async function getSignInSettings(sql: Sql): Promise<SignInSettings> {
  const [row] = await sql<{ auto_create: boolean | null; updated_at: Date; updated_by: string | null }[]>`
    SELECT auto_create, updated_at, updated_by FROM sign_in_settings WHERE id = 1`;
  return {
    autoCreate: row?.auto_create ?? null,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** Sets the given settings (null clears one back to the configuration's); leaves the others. */
export async function setSignInSettings(
  sql: Sql,
  change: { autoCreate?: boolean | null },
  by: string,
): Promise<SignInSettings> {
  const set = "autoCreate" in change;
  await sql`
    INSERT INTO sign_in_settings (id, auto_create, updated_at, updated_by)
    VALUES (1, ${set ? (change.autoCreate ?? null) : null}, now(), ${by})
    ON CONFLICT (id) DO UPDATE SET
      auto_create = ${set ? sql`EXCLUDED.auto_create` : sql`sign_in_settings.auto_create`},
      updated_at = now(),
      updated_by = EXCLUDED.updated_by`;
  return getSignInSettings(sql);
}
