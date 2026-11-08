---
"stardust": minor
---

Maintainers edit a project's env and secrets in the dashboard (**Environment** on the project page, `GET`/`PATCH /api/v1/projects/<id>/env`). Each change is one compare-and-swap commit to the deploy repository: the env layer, the rendered ConfigMap and SOPS-encrypted Secret of every component that reads it, and a pod-template stamp so the workloads roll out; a layer changed since it was read is refused. Secret values are write-only. It is off until the server is given `gitops-git`, `secrets-sops-age` and the age identity (`envEditing.ageKeySecret` in the chart); the server image now has git and sops.
