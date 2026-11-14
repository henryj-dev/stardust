---
"stardust": minor
---

Single sign-on sessions follow the provider's: signing out of stardust also signs out at the provider, and an OpenID Connect back-channel logout ends the matching stardust sessions. `identity-oidc` can require `amr` values (`mfa.requireAmr`), and a single sign-on session confirms it is you by signing in again at the provider.
