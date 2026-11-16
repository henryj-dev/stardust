import assert from "node:assert/strict";
import { it } from "node:test";
import {
  base32Decode,
  base32Encode,
  newRecoveryCodes,
  recoveryCodeHash,
  stepAt,
  totpCode,
  totpUri,
  verifyTotp,
} from "./totp.ts";

// RFC 6238 appendix B, SHA-1: the secret is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

it("produces RFC 6238's SHA-1 test codes (last six digits)", () => {
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(totpCode(RFC_SECRET, Math.floor(seconds / 30)), code, String(seconds));
  }
});

it("base32 round-trips and ignores spaces and case", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128, 7]);
  assert.deepEqual([...base32Decode(base32Encode(bytes))], [...bytes]);
  assert.deepEqual([...base32Decode("gezd gnbv")], [...base32Decode("GEZDGNBV")]);
});

it("accepts a code one step either side, never twice, never garbage", () => {
  const now = new Date(1111111111 * 1000);
  const step = stepAt(now);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, null), step);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, null), step - 1);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now, null), null, "too old");
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, step), null, "already used");
  assert.equal(verifyTotp(RFC_SECRET, "12345", now, null), null);
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", now, null), null);
});

it("writes the URI authenticator apps read", () => {
  assert.equal(
    totpUri("ABC", "stardust", "ada"),
    "otpauth://totp/stardust:ada?secret=ABC&issuer=stardust&algorithm=SHA1&digits=6&period=30",
  );
});

it("makes ten distinct recovery codes, hashed without regard to case or spaces", () => {
  const codes = newRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c)));
  assert.deepEqual(recoveryCodeHash(` ${codes[0]?.toUpperCase()} `), recoveryCodeHash(codes[0] ?? ""));
});
