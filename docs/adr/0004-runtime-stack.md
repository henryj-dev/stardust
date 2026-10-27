# 0004 — Runtime stack

- Status: Proposed
- Date: 2026-10-27

## Decision

- **Node.js 26** runs the server and worker directly from TypeScript sources
  using type stripping, so they have no build step. Only erasable syntax is
  allowed (`erasableSyntaxOnly`).
- **pnpm workspaces** for packages and plugins, with a single lockfile.
- **TypeScript 6.** TypeScript 7 is newer, but SvelteKit 3.1 and svelte-check
  4.7 support only `^6` at the time of writing. One version is used across the
  repository.
- **Hono** for HTTP, **SvelteKit 3** for the dashboard, **PostgreSQL** for
  state, **Biome** for lint and format, **dependency-cruiser** for boundaries,
  and the built-in **`node:test`** runner.

## Consequences

- Contributors need nothing beyond Node and pnpm.
- Workspace packages are resolved through symlinks to their real paths, which
  is what lets Node strip types in them (it refuses to inside
  `node_modules`). Container images keep the workspace layout for that reason;
  each image has a start-up smoke test so a missing package fails CI rather
  than production.
- Moving to TypeScript 7 waits for the dashboard toolchain.
