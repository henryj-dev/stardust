---
"stardust": patch
---

A job whose worker stopped (an upgrade or an evicted pod) is queued again and the next worker takes over the build or release Job already running, instead of the job being recorded as `unknown` while the Job went on to succeed. Only an operator's cancellation deletes the Job; after three stopped workers the job is `unknown`, with the reason on the run's page.
