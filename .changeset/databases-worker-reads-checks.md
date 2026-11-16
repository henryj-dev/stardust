---
"stardust": patch
---

Restore checks now finish: the worker, which follows their Jobs, gets its own account bound to the read-only `databases.namespaces` Roles (also when builds are off). Before, it could not read the Jobs and the checks stayed pending; a check it cannot follow is now logged.
