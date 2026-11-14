---
"stardust": minor
---

New `databases` port and `db-statefulset` plugin: finds PostgreSQL StatefulSets in the namespaces it is given and renders instances, application grants and encrypted backup CronJobs for the coming `databases` feature. The chart's `databases.namespaces` gives the server read-only access there.
