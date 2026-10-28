---
"stardust": patch
---

An empty plugin section (`source-github:` with nothing after it, or `{}` in Helm values, which Helm renders as null) enables the plugin with its defaults instead of stopping the server with "must be a mapping". The chart gives the dashboard `ORIGIN` from `config.server.publicUrl`: without it the dashboard assumed https and refused sign-in and every form posted over plain http as cross-site.
