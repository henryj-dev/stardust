---
"stardust": patch
---

The build state cache is compressed with pigz on every core and fetched over several streams, and a rebuild that reused the state no longer re-uploads it because an export wrote a runc log and a few small blobs. On pico's Rust image (a 3.15 GB state) a rebuild of the same commit spent about three of its four minutes moving the state; pigz halves it in 22 seconds.
