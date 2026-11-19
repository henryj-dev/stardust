---
"stardust": minor
---

Live logs come as server-sent events. A followed build or pod log is sent to the browser as `log` events (the text as JSON, every character kept), a `: heartbeat` comment every 5 seconds, and `end` when the log ends — the same shape as the project event stream. A proxy in front no longer closes a quiet log after its read timeout (nginx: 60 s), and the headers go out at once. A log read once (not followed, or a kept log) stays plain text; the API is unchanged.
