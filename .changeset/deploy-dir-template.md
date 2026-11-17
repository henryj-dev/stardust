---
"stardust": minor
---

A component's deploy directory can be filled in for you: set `gitops-git.deployDirTemplate` (for example `deploy/apps/{project}/{component}`), and the project form suggests the directory as the project id and component name are typed, while a directory typed by hand is kept. A component created through the API without a `deployDir` gets the template's (`GET /api/v1/deploy/defaults` tells administrators the template).
