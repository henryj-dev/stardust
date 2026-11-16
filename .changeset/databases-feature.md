---
"stardust": minor
---

New `databases` plugin: a Databases page to create PostgreSQL instances, adopt running ones, and give an application its own role and database, with its connection settings written to its env; and encrypted backups of every instance. All of it as commits to the deploy repository, with passwords generated and sealed on the server. Plugins can set secret env values through the new `projectEnv` port.
