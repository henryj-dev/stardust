---
"stardust": patch
---

The dashboard answers `GET /healthz` (and `HEAD`) with `200 ok`, without a session or a call to the API. Since 0.8.0 a signed-out `/` redirects to sign in, which proxies and load balancers checking for a 2xx read as down; point their health checks at `/healthz`. The chart's web probes use it too.
