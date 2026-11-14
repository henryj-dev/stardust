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

Rules that do no IO (CAS commits, image bumps, env rendering) live in core,
next to the port they use, so every implementation of a port shares them.

The server and the worker never import a plugin. `packages/bundle` lists the
plugins compiled in (enforced by `only-bundle-loads-plugins`), and
`assemble` from `@stardust/core` builds the ports each process wants.

| Plugin             | Provides     | Needs  |
| ------------------ | ------------ | ------ |
| `builder-buildkit` | `builder`    | `kube` |
| `gitops-git`       | `deployRepo` |        |
| `identity-oidc`    | `identity`   |        |
| `secrets-sops-age` | `cipher`     |        |
| `source-github`    | `source`     |        |

`kube` is provided by the server and the worker themselves (`packages/kube`).
