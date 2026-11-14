/**
 * Refuses to store a value in plain text when its name says it is a secret.
 * Plain values are committed to the deploy repository as a ConfigMap: a
 * secret saved there stays in the Git history of every clone, and taking it
 * back means rewriting history. So the default is to refuse, and the caller
 * names the keys that really are public. A warning nobody reads would not
 * protect anything; a guard that refuses normal public names gets turned
 * off, hence the public markers.
 */

/** Words in a name that mean "secret". A name is split on `_` and `-` and compared without them. */
const SECRET_MARKERS = [
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "PWD",
  "CREDENTIAL",
  "APIKEY",
  "PRIVATEKEY",
  "PRIVKEY",
  "DSN",
  "SALT",
  // Connection strings carry passwords.
  "DATABASEURL",
  "CONNECTIONSTRING",
];

/** Words that make a name public even with a secret marker (client ids, key ids, public keys). */
const PUBLIC_MARKERS = ["PUBLIC", "RECIPIENT", "CLIENTID", "KEYID", "KID", "PUBKEY"];

/**
 * Whether a variable name looks like it holds a secret. `KEY` alone does not
 * count (sort keys, cache keys); qualified keys do (API, access, signing …).
 */
export function looksLikeSecretKey(key: string): boolean {
  const n = key.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!n) return false;
  if (PUBLIC_MARKERS.some((p) => n.includes(p))) return false;
  if (SECRET_MARKERS.some((m) => n.includes(m))) return true;
  return /(API|ACCESS|SECRET|PRIVATE|SIGNING|ENCRYPTION|MASTER|AUTH|SESSION)KEY/.test(n);
}

/** The plain values that may not be saved as such: secret-looking names not declared public. */
export function plaintextSecrets(
  plain: Readonly<Record<string, string>>,
  declaredPublic: readonly string[] = [],
): string[] {
  return Object.keys(plain).filter((k) => looksLikeSecretKey(k) && !declaredPublic.includes(k));
}
