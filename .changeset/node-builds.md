---
"stardust": minor
---

Pipeline N builds: a Node application without a Dockerfile of its own is built with its lockfile's package manager and run from `build/` (or its own `server.js`). Components take `port` and `buildEnv` for it. The Dockerfile is a constant; the Node image, port and build environment reach it only as build arguments.
