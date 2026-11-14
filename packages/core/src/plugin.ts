/**
 * Plugin contract.
 *
 * Plugins are compiled into the binary and switched on by configuration —
 * there is no dynamic loading. A plugin only ever depends on `@stardust/core`;
 * the dependency rules in `.dependency-cruiser.cjs` enforce that.
 */

import {
  type FeatureContext,
  type Migration,
  type Permission,
  permissionProblems,
  type Route,
  type Schedule,
  scheduleProblems,
} from "./feature.ts";
import type { Logger } from "./logger.ts";
import type { PortName, Ports } from "./ports/index.ts";

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface PluginManifest {
  /** Stable identifier, also the key under `plugins:` in stardust.yaml. */
  readonly name: string;
  readonly description: string;
}

/** What a plugin is given when it builds its ports. */
export interface PluginContext {
  /** This plugin's section of stardust.yaml, already validated. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Resolves a `{ env }` or `{ file }` reference; `at` names it in errors. */
  resolveSecret(ref: unknown, at: string): Promise<string>;
  readonly log: Logger;
  /** The dashboard's public URL, without a trailing slash. */
  readonly publicUrl: string;
  /** The region this installation serves (`region` in stardust.yaml). */
  readonly region: string;
  /** Ports built before this plugin's: at least everything in `needs`. */
  readonly ports: Readonly<Partial<Ports>>;
}

export interface PortProvider {
  /** Every port `create` may return. Returning another is an error. */
  readonly ports: readonly PortName[];
  /** Ports it builds on. Without them `create` is not called and the plugin's ports stay off. */
  readonly needs?: readonly PortName[];
  /**
   * Builds the ports. It may return fewer than `ports` — a feature that is
   * configured but cannot run (a key that is not mounted, say) is logged
   * and left off rather than stopping start-up.
   */
  create(context: PluginContext): Promise<Partial<Ports>>;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  /**
   * Validates this plugin's section of stardust.yaml. Returns a list of
   * human-readable problems; an empty list means the section is valid.
   */
  validateConfig(section: unknown): string[];
  /** The ports this plugin implements. */
  readonly provides?: PortProvider;
  /** Ports this plugin cannot work without. Start-up stops, naming them, when one is missing. */
  readonly requires?: readonly PortName[];
  /** Permissions its routes check. Every route names one. */
  readonly permissions?: readonly Permission[];
  /** API routes, under `/api/v1/plugins/<name>`. Built once the ports exist. */
  routes?(context: FeatureContext): readonly Route[];
  /** Work run every so often by one worker at a time. */
  readonly schedules?: readonly Schedule[];
  /** Its own tables (named `<name>_*`), applied at start-up after stardust's. */
  migrations?(): Promise<readonly Migration[]>;
  /** What it adds, for the dashboard to show: e.g. `runtime.restart`. */
  readonly capabilities?: readonly string[];
}

export interface PluginRegistry {
  /** Returns the plugins enabled by `sections`, or throws listing every problem. */
  resolve(sections: Readonly<Record<string, unknown>>): Plugin[];
  names(): string[];
}

const EMPTY: readonly PortName[] = [];

export function definePlugin(plugin: Plugin): Plugin {
  const name = plugin.manifest.name;
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid plugin name "${name}": use lower-case words joined by "-"`);
  }
  const provided = plugin.provides?.ports ?? EMPTY;
  for (const port of plugin.provides?.needs ?? EMPTY) {
    if (provided.includes(port)) throw new Error(`plugin "${name}" needs the port it provides: ${port}`);
  }
  for (const port of plugin.requires ?? EMPTY) {
    if (provided.includes(port)) throw new Error(`plugin "${name}" requires the port it provides: ${port}`);
  }
  const problems = [...permissionProblems(name, plugin.permissions ?? []), ...scheduleProblems(plugin.schedules ?? [])];
  for (const capability of plugin.capabilities ?? []) {
    if (!capability.startsWith(`${name}.`)) problems.push(`capability "${capability}" must start with ${name}.`);
  }
  if (problems.length > 0) throw new Error(`plugin "${name}":\n  ${problems.join("\n  ")}`);
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
