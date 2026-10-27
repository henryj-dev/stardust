---
"stardust": minor
---

Administrators change users with `PATCH /api/v1/users/:username`: link or unlink an OpenID identity, grant or remove administration, disable (which ends the user's sessions and API tokens). A change that would leave no enabled administrator is refused.
