---
"stardust": minor
---

Creating a component's starter manifests now lists its directory in the nearest `kustomization.yaml` above it, in the same commit, so the GitOps controller applies it; before, the new files sat in the deploy repository and nothing ran until someone listed them by hand. The page says where it was listed, or that no kustomization above could list it. A new "Also create the namespace" option adds a Namespace with the restricted Pod Security standard (removed with the component, so leave it off for a shared namespace). The API takes `createNamespace` and answers `listedIn`.
