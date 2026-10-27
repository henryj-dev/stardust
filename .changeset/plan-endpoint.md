---
"stardust": minor
---

`POST /api/v1/projects/:id/plan` reports what a webhook delivery would do without doing it: the same policy, trigger and changed-path decision the webhook makes, and whether each job would run or be skipped. For running a new installation in the shadow of an existing one, and for checking a pipeline definition.
