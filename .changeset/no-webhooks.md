---
"stardust": minor
---

Webhooks are removed: a run starts only when someone with write access asks for one ("Pull and deliver", or `POST /api/v1/projects/:id/runs`), so a push or a merge never deploys by itself. `POST /webhooks/github/:project` and `POST /api/v1/projects/:id/plan` are gone, and projects no longer have a `webhookKind`. Upgrading needs no configuration change: a `webhookSecret` left in `plugins.source-github` is accepted, ignored and logged. Resolving a branch also works with Gitea's API now, which answers `branches/<name>` rather than `commits/heads/<name>`.
