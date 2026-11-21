---
"stardust": minor
---

The ports of a component's address outside the cluster can be changed in place: "Change the ports" on the component's page (`PUT /api/v1/plugins/runtime/projects/<p>/components/<c>/address/ports`, `{"ports": [{"port": 443, "targetPort": 8443}]}`, or no body for every port its containers declare) rewrites only the Service's ports, keeping its name, cluster IP and address, so nothing that routes to it has to change. Audited as `runtime.address.ports`. Giving the same port twice, when adding an address or changing its ports, is refused: the API server would refuse the Service and stop the GitOps controller.
