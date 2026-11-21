---
"stardust": minor
---

An administrator can bind a cluster-wide role to a component's own service
account from its page (Cluster roles), for example `system:auth-delegator`
for an app that checks tokens with a TokenReview. Only roles listed in
`runtime.allowedClusterRoles` are accepted, and every change is audited.
