/**
 * The composition root's one job: build the ports a process wants from the
 * enabled plugins. The server and the worker call this instead of importing
 * plugin functions, so adding a plugin changes no entry point.
 */
import {
  type FeatureContext,
  type Migration,
  type Permission,
  type Route,
  routeProblems,
  type Schedule,
} from "./feature.ts";
import type { Logger } from "./logger.ts";
import type { Plugin, PluginContext } from "./plugin.ts";
import { MULTI_PORTS, type PortName, type Ports } from "./ports/index.ts";

export interface AssembleOptions {
  /** Enabled plugins, as `PluginRegistry.resolve` returned them. */
  plugins: readonly Plugin[];
  /** `plugins:` of stardust.yaml: each plugin's section by name. */
  sections: Readonly<Record<string, unknown>>;
  /** The ports this process uses. Only providers of these (and what they need) are built. */
  want: readonly PortName[];
  /** Ports the process provides itself, such as `kube`. */
  platform?: Partial<Ports>;
  resolveSecret: PluginContext["resolveSecret"];
  log: Logger;
  publicUrl: string;
  /** Ports several plugins may provide under instance names. Defaults to MULTI_PORTS. */
  multiPorts?: ReadonlySet<PortName>;
}

export class AssemblyError extends Error {
  constructor(problems: string[]) {
    super(`cannot assemble plugins:\n  ${problems.join("\n  ")}`);
    this.name = "AssemblyError";
  }
}

type AnyPorts = Partial<Record<PortName, unknown>>;

/** Merges one plugin's ports into `into`; multi ports merge by instance name. */
function merge(into: AnyPorts, from: AnyPorts, owner: string, multi: ReadonlySet<PortName>, problems: string[]): void {
  for (const [name, value] of Object.entries(from) as Array<[PortName, unknown]>) {
    if (value === undefined) continue;
    if (!multi.has(name)) {
      into[name] = value;
      continue;
    }
    const existing = (into[name] ?? {}) as Record<string, unknown>;
    for (const instance of Object.keys(value as Record<string, unknown>)) {
      if (instance in existing) problems.push(`${owner}: a second ${name} named "${instance}"`);
    }
    into[name] = { ...existing, ...(value as Record<string, unknown>) };
  }
}

export async function assemble(options: AssembleOptions): Promise<Partial<Ports>> {
  const problems: string[] = [];
  const multi = options.multiPorts ?? MULTI_PORTS;
  const ports: AnyPorts = { ...options.platform };
  const providers = options.plugins.filter((p) => p.provides);

  // A single port has one provider; two enabled plugins providing it is a configuration mistake.
  const owner = new Map<PortName, string>();
  for (const plugin of providers) {
    for (const port of plugin.provides?.ports ?? []) {
      if (multi.has(port)) continue;
      const other = owner.get(port) ?? (options.platform?.[port] !== undefined ? "stardust itself" : undefined);
      if (other) problems.push(`port ${port} is provided by both ${other} and ${plugin.manifest.name}`);
      else owner.set(port, plugin.manifest.name);
    }
  }
  if (problems.length > 0) throw new AssemblyError(problems);

  // What to build: providers of wanted ports, then whatever those need, and so on.
  const wanted = new Set<PortName>(options.want);
  for (const plugin of options.plugins) for (const port of plugin.requires ?? []) wanted.add(port);
  const chosen = new Set<Plugin>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const plugin of providers) {
      if (chosen.has(plugin) || !plugin.provides?.ports.some((p) => wanted.has(p))) continue;
      chosen.add(plugin);
      for (const need of plugin.provides.needs ?? []) wanted.add(need);
      grew = true;
    }
  }

  // Build in dependency order. A provider whose needs never appear is skipped, and says so.
  const pending = [...chosen];
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (const plugin of [...pending]) {
      const provider = plugin.provides;
      if (!provider) continue;
      const needs = provider.needs ?? [];
      const blockedBy = needs.filter((n) => ports[n] === undefined);
      if (blockedBy.some((n) => pending.some((p) => p.provides?.ports.includes(n)))) continue;
      pending.splice(pending.indexOf(plugin), 1);
      progressed = true;
      const name = plugin.manifest.name;
      if (blockedBy.length > 0) {
        options.log.info(`${name} is off: it needs ${blockedBy.join(", ")}`, { plugin: name });
        continue;
      }
      const made = (await provider.create({
        config: (options.sections[name] ?? {}) as Record<string, unknown>,
        resolveSecret: options.resolveSecret,
        log: options.log,
        publicUrl: options.publicUrl.replace(/\/+$/, ""),
        ports: { ...ports } as Partial<Ports>,
      })) as AnyPorts;
      for (const port of Object.keys(made) as PortName[]) {
        if (!provider.ports.includes(port)) problems.push(`${name} returned port ${port}, which it does not declare`);
      }
      merge(ports, made, name, multi, problems);
    }
  }
  if (pending.length > 0) {
    problems.push(`cannot order providers (a cycle of needs): ${pending.map((p) => p.manifest.name).join(", ")}`);
  }

  for (const plugin of options.plugins) {
    const missing = (plugin.requires ?? []).filter((port) => ports[port] === undefined);
    if (missing.length > 0) {
      problems.push(`${plugin.manifest.name} requires ${missing.join(", ")}, which no enabled plugin provides`);
    }
  }
  if (problems.length > 0) throw new AssemblyError(problems);
  return ports as Partial<Ports>;
}

/** One enabled plugin's routes, permissions, schedules and the rest, ready to mount. */
export interface Feature {
  plugin: string;
  permissions: readonly Permission[];
  routes: readonly Route[];
  schedules: readonly Schedule[];
  capabilities: readonly string[];
  migrations: () => Promise<readonly Migration[]>;
  context: FeatureContext;
}

const NO_MIGRATIONS = async (): Promise<readonly Migration[]> => [];

/**
 * Builds every enabled plugin's features once its ports exist, and checks
 * the routes: each names one of the plugin's permissions, and each change
 * has an audit action.
 */
export function buildFeatures(
  plugins: readonly Plugin[],
  sections: Readonly<Record<string, unknown>>,
  ports: Partial<Ports>,
  log: Logger,
): Feature[] {
  const problems: string[] = [];
  const out: Feature[] = [];
  for (const plugin of plugins) {
    const name = plugin.manifest.name;
    const context: FeatureContext = {
      config: (sections[name] ?? {}) as Record<string, unknown>,
      ports,
      log,
    };
    const permissions = plugin.permissions ?? [];
    const routes = plugin.routes?.(context) ?? [];
    for (const problem of routeProblems(name, routes, permissions)) problems.push(`${name}: ${problem}`);
    out.push({
      plugin: name,
      permissions,
      routes,
      schedules: plugin.schedules ?? [],
      capabilities: plugin.capabilities ?? [],
      migrations: plugin.migrations
        ? () => (plugin.migrations as () => Promise<readonly Migration[]>)()
        : NO_MIGRATIONS,
      context,
    });
  }
  if (problems.length > 0) throw new AssemblyError(problems);
  return out;
}
