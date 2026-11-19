---
"stardust": minor
---

Components get persistent storage on their page: volumes with a mount path, a size and a StorageClass, written as a claim per volume next to the manifests and mounted in one commit, with fsGroup for non-root images and one pod at a time. Unmounting keeps the data; deleting it needs a confirmation. A claim already mounted under stardust's names (added by hand) is picked up as it is, and another claim the workload mounts can be taken over without being made again.
