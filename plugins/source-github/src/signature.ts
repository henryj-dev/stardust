import { createHmac, timingSafeEqual } from "node:crypto";

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Verifies GitHub's `X-Hub-Signature-256` header (`sha256=<hex HMAC of the body>`).
 *
 * The hex check comes first on purpose: `Buffer.from(x, "hex")` silently stops
 * at the first non-hex character, so a 64-character non-hex value would become
 * a short buffer and make `timingSafeEqual` throw — an unauthenticated caller
 * would get a server error instead of a plain rejection.
 */
export function verifySignature(body: string, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = header.slice("sha256=".length);
  if (!SHA256_HEX.test(given)) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}
