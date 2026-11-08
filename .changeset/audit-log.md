---
"stardust": minor
---

An audit log records who did what: sign-ins and failed sign-ins, sign-outs, users, password resets, API tokens, projects, members and runs. Administrators read it at **Audit log** (`GET /api/v1/audit`), a project's maintainers read their project's events; events name things and never hold a password, token or secret. `audit.retentionDays` (365 by default) sets how long events are kept.
