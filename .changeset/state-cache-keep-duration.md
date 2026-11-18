---
"stardust": patch
---

The build state cache prunes cache records unused for `stateCache.keepDuration` (default `168h`) before packing, not only when the state outgrows `maxBytes`: a cache mount a Dockerfile stopped using was otherwise carried, gigabytes at a time, on every build.
