---
"stardust": patch
---

Releases now publish the Vultr broker image, `ghcr.io/henryj-dev/stardust-vultr-broker`, for amd64 and arm64, signed and attested like the other images and listed with its digest in the release notes. Its tests run before it is pushed. The broker stays out of the Helm chart; `broker/vultr/README.md` explains how to pin it by digest and verify its signature.
