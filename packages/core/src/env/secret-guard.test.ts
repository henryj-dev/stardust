import assert from "node:assert/strict";
import { it } from "node:test";
import { looksLikeSecretKey, plaintextSecrets } from "./secret-guard.ts";

it("knows secret names, and does not stop public ones", () => {
  for (const key of [
    "GITHUB_TOKEN",
    "DB_PASSWORD",
    "DATABASE_URL",
    "api-key",
    "AWS_SECRET_ACCESS_KEY",
    "SENTRY_DSN",
    "SIGNING_KEY",
    "OIDC_CLIENT_SECRET",
  ]) {
    assert.equal(looksLikeSecretKey(key), true, key);
  }
  for (const key of [
    "PORT",
    "LOG_LEVEL",
    "PUBLIC_SITE_URL",
    "OIDC_CLIENT_ID",
    "SOPS_AGE_RECIPIENT",
    "CACHE_KEY",
    "SORT_KEY",
    "IDP_BASE_URL",
    "JWT_KID",
  ]) {
    assert.equal(looksLikeSecretKey(key), false, key);
  }
});

it("lists the plain values that would leak, unless declared public", () => {
  const plain = { PORT: "8080", API_TOKEN: "x", DATABASE_URL: "postgres://u:p@db/x" };
  assert.deepEqual(plaintextSecrets(plain), ["API_TOKEN", "DATABASE_URL"]);
  assert.deepEqual(plaintextSecrets(plain, ["DATABASE_URL"]), ["API_TOKEN"]);
});
