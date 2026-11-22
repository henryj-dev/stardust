import assert from "node:assert/strict";
import { it } from "node:test";
import type { AuditEventView, UserView } from "@stardust/sdk";
import { signInRequests } from "./sign-in-requests.ts";

const ISS = "https://id.example.com";
let n = 0;
const failed = (target: string | null, detail: Record<string, unknown>, at: string): AuditEventView => ({
  id: String(++n),
  at,
  actor: { kind: "anonymous", userId: null, name: null, tokenId: null },
  action: "auth.login.failed",
  projectId: null,
  target,
  detail,
  ip: null,
  forwardedFor: null,
  userAgent: null,
});
const user = (username: string, subject: string | null): UserView => ({
  id: username,
  username,
  displayName: "",
  isAdmin: false,
  disabled: false,
  hasPassword: false,
  oidc: subject ? { issuer: ISS, subject } : null,
  roles: [],
});

it("lists each person turned away for want of an account once, newest first, with what the provider said", () => {
  const events = [
    failed(
      "s-ana",
      {
        via: "oidc",
        reason: "no-account",
        issuer: ISS,
        claimed: { username: "ana", email: "ana@example.com", name: "Ana" },
      },
      "2026-01-03T00:00:00Z",
    ),
    failed(
      "s-bo",
      { via: "oidc", reason: "username-taken", issuer: ISS, claimed: { username: "bo" } },
      "2026-01-02T00:00:00Z",
    ),
    failed("s-ana", { via: "oidc", reason: "no-account", issuer: ISS }, "2026-01-01T00:00:00Z"),
  ];
  const got = signInRequests(events, []);
  assert.deepEqual(
    got.map((r) => [r.subject, r.reason, r.username, r.email, r.name, r.attempts]),
    [
      ["s-ana", "no-account", "ana", "ana@example.com", "Ana", 2],
      ["s-bo", "username-taken", "bo", null, null, 1],
    ],
  );
});

it("leaves out people an account now carries, other refusals, and password sign-ins", () => {
  const events = [
    failed("s-linked", { via: "oidc", reason: "no-account", issuer: ISS }, "2026-01-03T00:00:00Z"),
    failed("s-group", { via: "oidc", reason: "group", issuer: ISS }, "2026-01-03T00:00:00Z"),
    failed("s-off", { via: "oidc", reason: "disabled", issuer: ISS }, "2026-01-03T00:00:00Z"),
    failed(null, { via: "password", reason: "invalid" }, "2026-01-03T00:00:00Z"),
    // Recorded before stardust kept what the provider said: listed, with nothing claimed.
    failed("s-old", { via: "oidc", reason: "no-account", issuer: ISS }, "2026-01-01T00:00:00Z"),
  ];
  const got = signInRequests(events, [user("linked", "s-linked"), user("plain", null)]);
  assert.deepEqual(
    got.map((r) => [r.subject, r.username]),
    [["s-old", null]],
  );
});
