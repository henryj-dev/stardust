---
"stardust": minor
---

Plugins now provide ports (the source host, the deploy repository, the cipher, the builder, sign-in) that the server and the worker assemble from configuration, instead of each entry point wiring plugins by hand. Both processes now validate every plugin section at start-up, so a typo in any section stops either one.
