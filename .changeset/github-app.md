---
"stardust": minor
---

Private repositories through a GitHub App (`source-github.appId` and `privateKey`): each build gets a read-only token for its repository alone, in a Secret owned by the build Job and seen by the clone step only; a private repository the App is not installed on is refused. The chart lets the worker create Secrets and patch Jobs in the builds namespace.
