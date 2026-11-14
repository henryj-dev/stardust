---
"stardust": minor
---

New `runtime` plugin: a component's page shows its workloads, pods and recent events, and maintainers can restart it and change replicas or container resources, each as a commit to the deploy repository. The chart's `runtime.namespaces` gives the server a read-only Role in each listed namespace. Plugin permissions can now be granted per project, to its viewers or its maintainers.
