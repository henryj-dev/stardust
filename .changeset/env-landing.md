---
"stardust": minor
---

Env editing refuses a plain value whose name looks like a secret's unless it is declared public (`plainOnPurpose`), a component's page shows whether its env change has landed (applied, rolled out), the rendered ConfigMap's header names the configured env root, and stamping a pod template no longer reformats the rest of the manifest.
