---
"stardust": minor
---

The worker connects to PostgreSQL, applies the database migrations on start and runs the job queue. It builds images with rootless BuildKit as Kubernetes Jobs and commits digest-pinned image updates to the deploy repository, which the GitOps controller applies.
