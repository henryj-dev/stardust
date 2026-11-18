---
"stardust": minor
---

builder-buildkit `stateCache` keeps the whole BuildKit state of chosen components (cache mounts included) in an S3-compatible bucket between builds, so a Rust `target` or a package cache carries over without changing the Dockerfile. Only the restore and save containers hold the storage credential; the state is packed inside BuildKit's user namespace; any failure means a cold build, never a failed one.
