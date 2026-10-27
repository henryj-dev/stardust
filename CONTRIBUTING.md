# Contributing

Thanks for your interest. Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). stardust is pre-alpha, so expect the structure to
move; opening an issue before a large change saves everyone time.

## Setup

```sh
pnpm install
pnpm run check
```

`pnpm run check` must pass with no errors **and no warnings** before a pull
request is reviewed. It runs, in order: `typecheck`, `lint`, `deps`
(boundary rules), `test`, and the dashboard's `svelte-check`.

CI also builds the three images and runs two scripts you can run locally
with Docker:

- `tools/smoke-image.sh <server|worker|web> <image>` — the image refuses an
  invalid configuration and starts with a valid one.
- `tools/scan-secrets.sh` — scans the git history with gitleaks, after proving
  on a generated fake token that the scanner detects anything at all.

## Boundaries

`.dependency-cruiser.cjs` enforces:

| Rule                    | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `core-is-pure`          | `packages/core` imports nothing else from this repository. |
| `plugins-only-use-core` | A plugin may import `packages/core`, nothing else.         |
| `plugins-are-isolated`  | Plugins never import each other. Shared code goes to core. |
| `web-only-uses-sdk`     | The dashboard reaches the API only through `packages/sdk`. |
| `sdk-is-standalone`     | The client does not import server code.                    |
| `no-circular`           | No import cycles.                                          |

If a change needs to break a rule, discuss it in an issue first.

## Tests

- Tests use the built-in `node:test` runner and live next to the code as
  `*.test.ts`.
- A check is only useful if it can fail. When you add a guard (a rule, a
  validation, a policy), add a fixture that violates it and assert that it is
  stopped **by that guard** — not merely that something failed.
  `tools/dependency-rules.test.ts` is the pattern to follow.

## Code

- TypeScript is run directly by Node (type stripping), so only erasable syntax
  is allowed: no `enum`, `namespace` or constructor parameter properties.
  `tsconfig.json` enforces this with `erasableSyntaxOnly`.
- Relative imports include the `.ts` extension.
- Never commit environment-specific values (real hostnames, IP addresses,
  account names) or secrets. Configuration examples use `example.com`.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
and are written in English:

```
<type>(<optional scope>): <imperative summary, lower case, no period>

<body: what changed and why, wrapped at 72 columns>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`,
`build`, `ci`. Mark breaking changes with `!` after the type and a
`BREAKING CHANGE:` footer.

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
