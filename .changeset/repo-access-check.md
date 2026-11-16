---
"stardust": minor
---

The project form has a "Check access" button that says whether stardust can read the repository: public, through the GitHub App, with the configured token, or not at all. A project's settings show it when they open. It warns when stardust cannot read a repository, which runs would refuse, and when the GitHub App is installed on all of the owner's repositories, so a leaked key would read every one. The check is also `GET /api/v1/source/access?repo=owner/name`, for administrators, and `sourceAccess` in the SDK.
