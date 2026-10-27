---
"stardust": minor
---

The worker now connects to PostgreSQL, applies the database migrations on start and runs the job queue. Jobs fail with a clear log line until build executors are added.
