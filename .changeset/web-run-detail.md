---
"stardust": minor
---

Each run has its own page in the dashboard, linked from the project's run list and the home page: the run's ref, commit, who pulled it and when, and per job its status, attempt, start, finish and duration, why it failed, the image digest, the build job and the deploy commit. It updates live.

The page shows each job's build log as the build prints it, read from the build pod while the cluster keeps it (an hour after the build by default); after that the page says the log is gone, and a failed build still shows the last lines the worker kept. The API has `GET /api/v1/projects/:id/runs/:runId` and `GET /api/v1/projects/:id/runs/:runId/jobs/:job/log` (`?follow=true` to stream), and the SDK `run()` and `buildLog()`. Jobs in run views now carry `startedAt` and `finishedAt`.

With `builds.enabled`, the chart now gives the server its own service account with a token and a read-only Role in the builds namespace (get and list pods, get pod logs) to read build logs. Set `builds.logs: false` to keep the server without a token; runs then show no log.
