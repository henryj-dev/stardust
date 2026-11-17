---
"stardust": patch
---

A mirror (pipeline M) is reported as delivered: its Job's container is named like a build's, so the executor finds the digest line and the log reader the log. Before, every mirror failed with "printed no image digest" after copying the image.
