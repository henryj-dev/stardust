---
"stardust": minor
---

External projects (`trust: external` in a project's metadata): built without a clone token or project secret, only mirrored unless listed in `jobs.upstreamBuilds`, and run only at their `pin`. New pipeline M mirrors a published image pinned by digest into your registry, checking the copy's digest. Pipeline W components may now have `buildEnv`.
