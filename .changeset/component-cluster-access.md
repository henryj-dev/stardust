---
"stardust": minor
---

A component's namespace can get what it needs from the cluster from the dashboard, instead of by hand in the deploy repository. With a read-only registry login in `plugins.builder-buildkit.pull`, stardust seals a pull Secret into the component's directory and names it in the workloads' `imagePullSecrets`; when the login changes, one button reseals them all in one commit. With the chart's new `runtime.bindings: true`, the chart ships a read-only ClusterRole bound nowhere, and the component binds it in its own namespace, so the dashboard shows its pods without a chart change. Both can be chosen when scaffolding or turned on and off later on the component's page (`GET`/`PUT …/components/<name>/access`, `POST /api/v1/registry/pull/reseal`). Scaffolding can also make the Service a LoadBalancer (`expose`), and the component's page shows its Services and the address an edge proxy sends traffic to. The runtime Role now also reads Services.
