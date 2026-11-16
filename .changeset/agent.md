---
"stardust": patch
---

The node agent's source is now in `agent/`. It no longer has a built-in server address: it exits quietly until `/etc/node-agent/url` is set, and accepts `http://` as well as `https://`.
