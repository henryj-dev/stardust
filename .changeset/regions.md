---
"stardust": minor
---

Several regions: `database.globalUrl` names the primary every region shares (both databases get the whole schema; regional databases keep replicated copies of the global tables), and a project belongs to the region it was made in: other regions refuse to change it, answering 409 with the owner.
