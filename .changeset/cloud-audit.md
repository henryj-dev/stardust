---
"stardust": minor
---

New `cloud-audit` and `audit-cloudflare` plugins: stardust reads a Cloudflare account's audit log every 30 minutes and shows on a Cloud audit page what its rules find (automation tokens out of scope, changes to protected areas, unknown tokens, failed attempts). The rules are in core and work on any `auditLogs` source.
