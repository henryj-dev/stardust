---
"stardust": patch
---

The chart installs through Flux from OCI: the `helm.sh/chart` label no longer carries the `+<digest>` build metadata that Flux appends to the chart version, which the API server rejects as a label value.
