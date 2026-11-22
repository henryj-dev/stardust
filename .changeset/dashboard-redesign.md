---
"stardust": minor
---

The dashboard is redesigned: a new sign-in page, an app layout with a sidebar and an account menu, a sortable audit table, tabbed account settings, and a users list with a menu of actions per account. Everything the users page did stays: the single sign-on setting, the people waiting to be let in, and linking or unlinking single sign-on per account. Linking someone from the waiting list starts with no account chosen.

Giving an account to someone from the waiting list no longer depends on reaching the identity provider: the issuer recorded with their sign-in is used. Given only a subject while the provider cannot be reached, the API answers 502 with the reason instead of 500.
