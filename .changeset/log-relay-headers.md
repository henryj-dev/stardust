---
"stardust": patch
---

A followed log opens at once: a pod (or build) that had printed nothing yet left the browser on "connecting", because SvelteKit's Node adapter sends the headers only with the first byte of the body. The relay now leads the body with an empty chunk, which sends them.
