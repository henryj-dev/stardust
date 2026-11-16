---
"stardust": minor
---

Two-step sign-in for local accounts: TOTP with any authenticator app and one-time recovery codes, set up on the Account page, with `auth.local.totp` off, optional (default) or required and an optional `auth.local.totpKey` that seals the secrets. Deleting a project, issuing a sign-in link and resetting someone's TOTP now need a recent sign-in (`auth.reauthMinutes`), confirmed with the password or a code. `auth.local.enabled: false` turns password sign-in off.
