# stardust

**One push. Everything after it is a commit.**

stardust is a GitOps delivery platform for Kubernetes. A push to your source
repository builds an image inside your cluster and records the new desired
state as a commit in your deploy repository; Flux applies it. Nothing reaches
the cluster except through a commit somebody can read afterwards.

> **Status: pre-alpha.** This repository is being rebuilt from an internal
> system. Nothing here is usable yet — follow the milestones below.

## Principles

- **Git is the only way in.** stardust writes desired state to Git and never
  applies it to a cluster directly.
- **One binary, plugins by configuration.** Integrations (source hosts,
  builders, secret backends, DNS, clouds) are plugins compiled into the
  binary and switched on in `stardust.yaml`. There is no dynamic loading.
- **No secrets in configuration.** `stardust.yaml` refers to secrets by
  environment variable or file; a plain-text secret is a configuration error.
- **Releases are signed.** Only images and charts built from signed tags are
  meant to be deployed.

## Repository layout

| Path              | What it is                                                          |
| ----------------- | ------------------------------------------------------------------- |
| `packages/core`   | Domain model and the plugin contract. Depends on nothing else here. |
| `packages/config` | `stardust.yaml` schema and loader.                                  |
| `packages/server` | HTTP API (Hono).                                                    |
| `packages/worker` | Background jobs, scheduling and sagas.                              |
| `packages/sdk`    | API client used by the dashboard (to be generated from OpenAPI).    |
| `packages/web`    | Dashboard (SvelteKit).                                              |
| `plugins/`        | Integrations. Each plugin depends only on `packages/core`.          |
| `agent/`          | Node agent (Go).                                                    |
| `examples/`       | Example configuration.                                              |

The boundaries between these are enforced by `.dependency-cruiser.cjs`; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Supported environments

stardust targets one well-defined setup rather than every possible one:

| Area              | Supported                       |
| ----------------- | ------------------------------- |
| Cluster           | Kubernetes 1.30+ (k3s included) |
| GitOps controller | Flux 2.8+                       |
| Source host       | GitHub (GitHub App)             |
| Secrets in Git    | SOPS with age                   |
| Database          | PostgreSQL 16+                  |

Anything else is unsupported until a plugin for it exists. See
[docs/adr](docs/adr) for the decisions behind this.

## Development

Requirements: Node.js 26+ and pnpm 12+.

```sh
pnpm install
pnpm run check          # typecheck, lint, boundary rules, tests, dashboard check
```

Run the API against the example configuration:

```sh
DATABASE_URL=postgres://localhost/stardust \
STARDUST_CONFIG=examples/stardust.yaml \
node packages/server/src/main.ts
curl localhost:8080/healthz
```

Node runs the TypeScript sources directly (type stripping), so there is no
build step for the server and worker.

## Milestones

1. Skeleton and signed release pipeline — _in progress_
2. Push → build → GitOps commit → Flux, end to end on kind
3. Environment and secret cascade (SOPS + age), OIDC sign-in, RBAC
4. First public release

## License

[Apache-2.0](LICENSE)
