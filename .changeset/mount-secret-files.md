---
"stardust": minor
---

A component can read env secrets as files. On its page, choose a secret and a path in the container (`/etc/app/key.pem`), and stardust commits a read-only mount of that key to the component's Deployment, each file on its own path so the rest of the directory stays as it is. Only secrets the component's env Secret has can be mounted; clearing a path removes the file. The API is `GET` and `PUT /api/v1/projects/<id>/components/<name>/files`, for the project's maintainers; the audit log names keys and paths, never values.
