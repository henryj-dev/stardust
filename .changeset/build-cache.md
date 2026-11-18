---
"stardust": minor
---

Builds reuse layers between runs: builder-buildkit imports and exports a registry cache at `<repository>:buildcache` per component (`cache: registry`, the default; `off` to build from scratch). External projects' builds never use one, and a failed export does not fail the build.
