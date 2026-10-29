Parts that `tools/node-build-test.sh` puts into a copy of `../default` to try each
way a pipeline N build installs. Made by the package managers themselves, not by hand:

- `empty.pnpm-lock.yaml` — `pnpm install --lockfile-only` (pnpm 12.14.0) for an app without dependencies
- `pinned.package.json` — the default fixture's package.json plus a dependency on `ms@^2.1.2`, which resolves to 2.1.3 when resolved fresh
- `pinned.package-lock.json` — `npm install --package-lock-only` with ms at 2.1.2
- `pinned.yarn.lock` — yarn 1.22.22 with ms at 2.1.2 (entry key changed to the range above)
- `empty.bun.lock` — the shape of bun's text lockfile; only its presence matters
