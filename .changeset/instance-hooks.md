---
"stardust": minor
---

Instances: an `instanceHooks` port lets other systems enrol and release instances. A hook may add to an instance's cloud-init (joined as multipart, never stored, cleared once the instance runs) or refuse a create, and is told when an instance runs and around its deletion, which it may refuse.
