---
"stardust": minor
---

Single sign-on accounts are managed on the Users page. People the provider signed in who have no account are listed under "Waiting to be let in", with the username, email and name the provider gave (now kept in the `auth.login.failed` audit event), to be given an account or linked to one; each account links or unlinks single sign-on by subject, and "Add a user" takes a subject instead of an invitation. The API takes `oidc: {subject}` for the server's own provider when creating or changing a user.

Adding a user on the Users page works again: the API refused an account without a password or an identity, which is how the page adds one before issuing its invitation, and it dropped the display name.
