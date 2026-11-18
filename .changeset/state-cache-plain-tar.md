---
"stardust": patch
---

The build state cache is a plain tar and is saved only when the build wrote something new into it: on pico's Rust image a rebuild spent three of its four minutes compressing, decompressing and re-uploading an unchanged 1.5 GB state.
