---
"stardust": minor
---

Administrators choose on the Users page whether a first single sign-on creates an account: create one, turn them away (they then wait on the same page to be let in), or as `stardust.yaml` says. The choice is kept in the database (migration `0016_sign_in_settings`), takes precedence over `identity-oidc.autoCreate` until set back, and is audited as `auth.settings.update`. API: `GET`/`PUT /api/v1/auth/settings`.
