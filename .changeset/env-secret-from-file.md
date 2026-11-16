---
"stardust": minor
---

A value on the env page can now come from a file: a key, a JSON credential or a config file, taken exactly as it is, newlines included. Only UTF-8 text up to 32 KiB is accepted, and not a typed value and a file together. Before this, secrets were typed into a one-line field, so a multi-line key could not be stored at all.
