---
"stardust": patch
---

"Add an address outside" no longer commits a second Service for a database. An adopted instance is refused (409) and the dashboard no longer offers it there, nor shows an address recorded for one: its own app's Service gives it its address. Before committing a new `<name>-db` Service, the server asks the cluster whether one of that name exists in the instance's namespace and refuses (409) when it does, since another cluster IP for the same name stops the GitOps controller's dry-run. When the cluster cannot be read, the check is skipped and logged.
