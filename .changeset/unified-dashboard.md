---
"stardust": minor
---

One dashboard over several regions: with `web.regions` (STARDUST_REGIONS), the web sends each project's work to the region that owns it and reads shared things from whichever region answers; a region that is down fails only what belongs to it. The SDK's `createClient` takes `regions` for the same.
