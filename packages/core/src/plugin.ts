/**
 * Plugin contract.
 *
 * Plugins are compiled into the binary and switched on by configuration —
 * there is no dynamic loading. A plugin only ever depends on `@stardust/core`;
 * the dependency rules in `.dependency-cruiser.cjs` enforce that.
 */

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface PluginManifest {
  /** Stable identifier, also the key under `plugins:` in stardust.yaml. */
  readonly name: string;
  readonly description: string;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  /**
   * Validates this plugin's section of stardust.yaml. Returns a list of
   * human-readable problems; an empty list means the section is valid.
   */
  validateConfig(section: unknown): string[];
}

export interface PluginRegistry {
  /** Returns the plugins enabled by `sections`, or throws listing every problem. */
  resolve(sections: Readonly<Record<string, unknown>>): Plugin[];
  names(): string[];
}

export function definePlugin(plugin: Plugin): Plugin {
  if (!NAME_RE.test(plugin.manifest.name)) {
    throw new Error(`invalid plugin name "${plugin.manifest.name}": use lower-case words joined by "-"`);
  }
  return plugin;
}

export function createPluginRegistry(plugins: readonly Plugin[]): PluginRegistry {
  const byName = new Map<string, Plugin>();
  for (const plugin of plugins) {
    const name = plugin.manifest.name;
    if (byName.has(name)) {
      throw new Error(`duplicate plugin name "${name}"`);
    }
    byName.set(name, plugin);
  }

  return {
    names: () => [...byName.keys()].sort(),
    resolve(sections) {
      const problems: string[] = [];
      const enabled: Plugin[] = [];
      for (const [name, section] of Object.entries(sections)) {
        const plugin = byName.get(name);
        if (!plugin) {
          problems.push(
            `plugins.${name}: unknown plugin (available: ${[...byName.keys()].sort().join(", ") || "none"})`,
          );
          continue;
        }
        for (const problem of plugin.validateConfig(section)) {
          problems.push(`plugins.${name}: ${problem}`);
        }
        enabled.push(plugin);
      }
      if (problems.length > 0) {
        throw new Error(`invalid plugin configuration:\n  ${problems.join("\n  ")}`);
      }
      return enabled;
    },
  };
}
