---
"stardust": minor
---

Starter manifests now read the env page's values as environment variables (an optional `envFrom` for the env ConfigMap and Secret), so values set on the env page reach the process. An existing component can be wired the same way from Cluster access on its page.
