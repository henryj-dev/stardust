---
"stardust": patch
---

Live build logs, pod logs and the project event stream reach the browser as they are written when an nginx sits in front: their responses say `X-Accel-Buffering: no`, so the proxy no longer holds them back until its buffer fills.
