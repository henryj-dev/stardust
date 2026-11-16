---
"stardust": patch
---

Databases: backups and grants now sign in as the instance's own superuser role. `db-statefulset` reads it from the pod's `POSTGRES_USER` (`postgres` when that is absent), so instances made by the official image with another `POSTGRES_USER` no longer fail with "role postgres does not exist". Adopted instances remember the role (existing ones keep `postgres`). An instance whose `POSTGRES_USER` comes from a Secret, a ConfigMap or `envFrom` is not adoptable until it is set as a plain value.
