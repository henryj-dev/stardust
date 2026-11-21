---
"stardust": minor
---

A component's page has a Workload section: its own service account with a
token (or no token), HTTP startup, readiness and liveness probes, a read-only
root filesystem with writable paths, numeric user and group ids, and rolling
one pod at a time (`maxSurge: 0`, never `Recreate`). Each save is one commit
to the component's manifests, and the section says why a namespace enforcing
the restricted Pod Security standard would refuse the pods. Scaffolding takes
the same settings.
