---
"stardust": minor
---

The env editor adopts a component's hand-made `<component>-env` ConfigMap or `<component>-env-secret` Secret with the next change (or on its own with "Move them now"): their values move into the component's layer and their documents leave their files in the same commit, instead of a second object by the same name breaking the kustomization. Kustomization entries with a trailing comment are now read, added after and removed correctly.
