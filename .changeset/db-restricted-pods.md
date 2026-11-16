---
"stardust": patch
---

Databases: every pod the `db-statefulset` plugin renders (the instance, grant Jobs, the backup CronJob and restore checks) now passes Pod Security Admission `restricted`: non-root as uid 70, `RuntimeDefault` seccomp, no privilege escalation, all capabilities dropped. Backups and restore checks no longer install packages at run time; each step runs in an official image pinned by digest (postgres, SOPS, the AWS CLI), sharing an `emptyDir`. Dumps are now encrypted with SOPS to the same age recipient and stored as `dumpall-<stamp>.sql.gz.sops.json` beside their `.fingerprint`; older `.sql.gz.age` dumps are still pruned by retention but are not read by the restore check, so run a backup before the next check.
