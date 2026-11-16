---
"stardust": minor
---

Databases: backups now store a fingerprint of each source with its dump, and "Check that it restores" restores the newest dump into a throwaway server and compares. Instances can be deleted when `databases.allowDelete` is on, after their grants are revoked and a restore check passed. Plugin routes can require a recent sign-in with `fresh: true`.
