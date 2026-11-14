---
"stardust": minor
---

New `compute` port and `cloud-vultr` plugin for Vultr instances, meant to run behind the Vultr broker now in `broker/vultr`: the broker holds the account key, lets through only stardust's calls, and deletes only with a signed, single-use ticket for one instance.
