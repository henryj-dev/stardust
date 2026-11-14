---
"stardust": minor
---

Plugins can add API routes under `/api/v1/plugins/<plugin>/` (each behind one of the plugin's own permissions, and audited when it changes something), their own tables, schedules that run on one worker at a time, and capabilities that `GET /api/v1/capabilities` lists for the dashboard.
