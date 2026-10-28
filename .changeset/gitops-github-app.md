---
"stardust": minor
---

The deploy repository can be written as a GitHub App (`plugins.gitops-git.githubApp`: `appId`, `privateKey`) instead of with a long-lived token. stardust asks for installation tokens narrowed to the deploy repository and to `contents: write`, renews them before they expire, and gives git the credential only for commands that reach the host.
