---
"stardust": minor
---

**`region` is now required in `stardust.yaml`** (under Helm, `config.region`): the region this installation serves, a lower-case name with no default. Plugins see it, their migrations say whether each one is global or regional, and access decisions, accounts, roles, projects and the audit log go through a global database handle (the same database until stardust runs in several regions).
