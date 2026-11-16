---
"stardust": minor
---

A run is now refused before building when a component's deploy directory has no manifest using its image. Administrators can scaffold starter manifests into an empty deploy directory, change components one at a time, and delete a project, optionally withdrawing its manifests from the deploy repository in one commit.
