---
"stardust": minor
---

The chart sets the web pod's `ADDRESS_HEADER` and `XFF_DEPTH` from `web.addressHeader` and `web.xffDepth` (default 1). Behind a reverse proxy the dashboard otherwise passes the proxy's address to the audit log for every browser sign-in and action.
