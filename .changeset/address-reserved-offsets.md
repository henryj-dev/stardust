---
"stardust": patch
---

An address outside the cluster is never given the addresses Kubernetes holds at the start of its Service range. With a block that starts the range and the cluster's Services not listable, `.1` (`default/kubernetes`) was given out; the API server refused the Service and the GitOps controller's apply stopped. `runtime.external` and `databases.external` take `reserved` (default `[1, 10]`, `.10` being the usual cluster DNS), and the block's first and last address are never given out. The runtime plugin now logs when it cannot list the cluster's Services instead of going on silently.
