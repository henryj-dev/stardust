# Plugins

Each directory here is one plugin: a workspace package named
`@stardust/plugin-<name>` that exports a `Plugin` built with `definePlugin`
from `@stardust/core`.

A plugin:

- depends only on `@stardust/core` (enforced by `plugins-only-use-core`);
- never imports another plugin (enforced by `plugins-are-isolated`);
- validates its own section of `stardust.yaml` in `validateConfig`, returning
  every problem rather than stopping at the first.

No plugins exist yet.
