---
"stardust": minor
---

Manual runs: `POST /api/v1/projects/:id/runs` (and "Pull and deliver" on a project's page) builds and delivers the default branch's head, or a chosen branch, tag or commit. A commit given by hash must be in the default branch's history. The run records who asked. A project with `webhookKind: "off"` ignores webhooks and is delivered this way only. The source token, the webhook secret and the builder's clone secret are now optional, so a public repository can be delivered with no credentials for its host.
