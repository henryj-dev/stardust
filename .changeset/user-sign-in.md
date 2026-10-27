---
"stardust": minor
---

Users sign in with a username and password instead of a shared admin token. `server.adminToken` is replaced by `server.bootstrapAdmin`, which creates the first administrator once, while there are no users. Projects grant `maintainer` or `viewer` roles; people who are not members get 404 for a project.
