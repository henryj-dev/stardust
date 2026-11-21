---
"stardust": patch
---

A database's address outside the cluster no longer takes an N that a Service
elsewhere in the deploy repository holds (an app's own, or a component's):
every manifest below `databases.external.scan` (default the whole repository)
counts, not only those under the databases root.
