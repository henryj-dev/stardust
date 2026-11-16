---
"stardust": patch
---

The `databases` plugin no longer stops the worker from starting where only the server holds the age key: the cipher is needed only to create an instance or grant a role, and those answer 503 in a process without it.
