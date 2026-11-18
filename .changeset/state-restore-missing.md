---
"stardust": patch
---

The build state cache falls back to the plain archive again: rclone's copyto exits 0 for an object that does not exist, so a missing `.tar.gz` counted as fetched and the `.tar` an earlier release saved was never restored. A fetch now counts only when the file is there.
