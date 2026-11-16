/** How long a new API token lasts, as the form offers it: days, or "never". */
export const TOKEN_EXPIRY_CHOICES = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "never", label: "Never" },
] as const;

export const DEFAULT_TOKEN_EXPIRY = "30";

/** The days a choice stands for (null: never), or undefined for a value the form does not offer. */
export function expiryDaysFrom(value: FormDataEntryValue | null): number | null | undefined {
  if (typeof value !== "string") return undefined;
  if (!TOKEN_EXPIRY_CHOICES.some((c) => c.value === value)) return undefined;
  return value === "never" ? null : Number(value);
}

export type TokenRequest =
  | { ok: true; name: string; expiresInDays: number | null }
  | { ok: false; error: string; name: string; expiry: string };

/** Reads the new-token form: a name of at most 100 characters and one of the offered lifetimes. */
export function tokenRequestFrom(form: FormData): TokenRequest {
  const name = String(form.get("name") ?? "").trim();
  const raw = form.get("expiry");
  const expiry = typeof raw === "string" ? raw : DEFAULT_TOKEN_EXPIRY;
  if (!name) return { ok: false, error: "Give the token a name.", name, expiry };
  if (name.length > 100) return { ok: false, error: "The name is too long (at most 100 characters).", name, expiry };
  const expiresInDays = expiryDaysFrom(raw);
  if (expiresInDays === undefined)
    return { ok: false, error: "Choose how long the token lasts.", name, expiry: DEFAULT_TOKEN_EXPIRY };
  return { ok: true, name, expiresInDays };
}
