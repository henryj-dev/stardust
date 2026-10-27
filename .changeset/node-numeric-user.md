---
"stardust": patch
---

Pipeline N images run as user `1000:1000` instead of `node`: with `runAsNonRoot`, Kubernetes refused to start a container whose image user is a name it cannot check.
