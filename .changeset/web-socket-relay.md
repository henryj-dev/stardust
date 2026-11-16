---
"stardust": patch
---

Plugin WebSockets now work through the dashboard: the web server hands upgrades under `/api/v1/plugins/<plugin>/` to the API unchanged, so node agents can connect where the dashboard is the only way in. Other upgrades are refused at the dashboard.
