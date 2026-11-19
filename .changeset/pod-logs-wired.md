---
"stardust": patch
---

Pod logs work again: the runtime plugin now says it uses the log sources, so logs-kube and logs-loki are built when enabled (they were never built, and the pod page said no live log source was enabled). A live log is followed again: the page added `?follow=true` after a URL that already had a query.
