---
"stardust": patch
---

Creating a database instance with an address outside the cluster no longer fails when the databases root lists a directory that holds directories (such as the backups). Reading a directory from the Git deploy repository now answers "no such file", as the other repositories do, instead of failing.
