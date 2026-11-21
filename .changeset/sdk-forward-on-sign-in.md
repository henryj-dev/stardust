---
"stardust": patch
---

Sign-ins through the dashboard are recorded with the browser's address and user agent. The client's `login`, `loginCode` and `oidcCallback` sent only a content type, so every password, second-step and single sign-on attempt from the dashboard was recorded with the dashboard's own address, whatever `ADDRESS_HEADER` said.
