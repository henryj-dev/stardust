---
"stardust": minor
---

The dashboard has a home page: signed in, `/` lists the projects you can read with each one's latest run (when, ref, commit, status, who pulled it) and links to the project; signed out, it sends you to sign in and back. Every page has a header with your name and a Sign out button. A session the API no longer accepts is dropped on the next request, so you are asked to sign in again instead of seeing an error. `GET /api/v1/projects` now gives each project a `lastRun` (its newest run without jobs, or `null`), and the SDK has `session()`.
