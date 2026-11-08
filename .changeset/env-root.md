---
"stardust": minor
---

The env layers' directory in the deploy repository can be set with `gitops-git`'s `envRoot` (default `deploy/env`, as before). Every layer moves with it, the global one included, so several installations can share one deploy repository without reading each other's global env, and each one's age identity only needs to open the files under its own root.
