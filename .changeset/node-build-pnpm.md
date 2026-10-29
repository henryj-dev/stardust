---
"stardust": minor
---

Pipeline `N` builds install with pnpm whatever lockfile the app carries, and run with node. A `pnpm-lock.yaml` is used as it is; an npm or yarn lockfile is turned into one by `pnpm import`, so its pinned versions are kept; a bun lockfile, or none, is resolved fresh from `package.json`; lockfiles of more than one package manager stop the build. pnpm is pinned (12.14.0) unless the app names its own in `packageManager`. Apps that carried only a bun lockfile could not be built before.
