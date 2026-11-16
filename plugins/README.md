# Plugins

Each directory here is one plugin: a workspace package named
`@stardust/plugin-<name>` that exports a `Plugin` built with `definePlugin`
from `@stardust/core`.

A plugin:

- depends only on `@stardust/core` (enforced by `plugins-only-use-core`);
- never imports another plugin (enforced by `plugins-are-isolated`);
- validates its own section of `stardust.yaml` in `validateConfig`, returning
  every problem rather than stopping at the first;
- implements **ports** declared in `packages/core/src/ports/`: `provides.ports`
  names them, `provides.create` builds them from the plugin's section, and
  `provides.needs` names the ports it builds on (the builder needs `kube`).
  A plugin that cannot work without a port lists it in `requires`, and
  start-up stops naming it when it is missing.

A feature plugin may also declare, all checked when it is defined or mounted:

- `permissions`: `<plugin>:<verb>`, granted to `admins`, `signed-in`, or per
  project to `project-readers` (viewers and maintainers) or `project-writers`
  (maintainers) — those routes name the project as `:project`;
- `routes(context)`: served under `/api/v1/plugins/<plugin>`, each with one
  of its permissions, and an audit action for every change;
- `schedules`: run by one worker at a time, at most once per interval;
- `migrations()`: its own tables, named `<plugin>_*`;
- `capabilities`: what the dashboard may show, `<plugin>.<what>`.

A route may answer with `stream` instead of a JSON body: plain text sent as it
comes (a followed log), with `nosniff`, ended by the request's signal.

Shared machinery in core, so each plugin does not grow its own:

- **sagas** (`defineSaga`, `startSaga`, `runSaga`, the `sagas` port): work in
  named steps against outside systems. Each step is recorded as it finishes;
  a process that dies resumes where it stopped, and a failed step undoes the
  finished ones in reverse. Safety steps (a final backup before a delete, say)
  are steps of the saga, never something an adapter may skip.
- **guards** (the `guards` port): `issueApproval`/`checkApproval` for a ticket
  bound to one action on one target, valid briefly and once; `isProtected` for
  targets that may never be destroyed; `allowReveal` for revealing secrets at
  most so often.
- **contract suites** (`@stardust/core/testing`): `repoContract`,
  `sagaStoreContract`, `guardStoreContract`. A port's fake and every real
  implementation run the same suite, so a test against the fake says
  something about the real thing. A new port comes with its suite.

Rules that do no IO (CAS commits, image bumps, env rendering) live in core,
next to the port they use, so every implementation of a port shares them.

The server and the worker never import a plugin. `packages/bundle` lists the
plugins compiled in (enforced by `only-bundle-loads-plugins`), and
`assemble` from `@stardust/core` builds the ports each process wants.

| Plugin             | Provides                                             | Needs  |
| ------------------ | ---------------------------------------------------- | ------ |
| `builder-buildkit` | `builder`                                            | `kube` |
| `dns-cloudflare`   | `dns` (`cloudflare`)                                 |        |
| `dns-parallax`     | `dns` (`parallax`, internal/external views)          |        |
| `gitops-git`       | `deployRepo`                                         |        |
| `identity-oidc`    | `identity`                                           |        |
| `logs-kube`        | `logs` (`kube`, live)                                | `kube` |
| `logs-loki`        | `logs` (`loki`, history)                             |        |
| `store-s3`         | `store`                                              |        |
| `runtime`          | (feature: requires `kube`, `deployRepo`, `projects`) |        |
| `secrets-sops-age` | `cipher`                                             |        |
| `source-github`    | `source`                                             |        |

`kube` is provided by the server and the worker themselves (`packages/kube`).
