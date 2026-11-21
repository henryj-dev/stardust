---
"stardust": minor
---

A component's page has a Secret files section: secrets read from disk that
are not environment variables, such as a 32-byte key. stardust generates the
value (or takes an uploaded file, binary included), seals it with SOPS in a
Secret of its own that is never read with `envFrom`, and mounts it read-only
at `/run/secrets/<set>/<key>` (0440, through the pod's fsGroup). Values are
never shown; administrators only, audited.
