---
"stardust": minor
---

Pod logs on a component's page: the new `logs-kube` plugin follows live pods through the Kubernetes API, and `logs-loki` reads what Loki kept after a pod is gone. Only a component's own pods can be read. Plugin routes can now stream plain text.
