---
"stardust": patch
---

The dashboard honours `ORIGIN`. 0.4.1 set it from `config.server.publicUrl`, but SvelteKit 3 reads the origin only at build time, so it had no effect and forms posted over plain http were still refused as cross-site. The image now starts through its own entry point, which gives the adapter that origin on every request.
