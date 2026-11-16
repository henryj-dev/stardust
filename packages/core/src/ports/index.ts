/**
 * Ports: what plugins provide and what the rest of stardust uses. A port is
 * a type here and an implementation in a plugin (or, for `kube`, in the
 * composition root), so a second implementation needs no change outside its
 * own plugin.
 */
import type { GuardStore } from "../guard.ts";
import type { SagaStore } from "../saga.ts";
import type { Builder, ImageNaming } from "./builder.ts";
import type { SecretCipher } from "./cipher.ts";
import type { ComputeProvider } from "./compute.ts";
import type { Database } from "./database.ts";
import type { DatabaseProvider } from "./databases.ts";
import type { DeployTarget } from "./deploy-target.ts";
import type { DnsProvider } from "./dns.ts";
import type { IdentityProvider } from "./identity.ts";
import type { InstanceHook } from "./instance-hooks.ts";
import type { KubeStreamClient } from "./kube.ts";
import type { LogSource } from "./logs.ts";
import type { ProjectEnv } from "./project-env.ts";
import type { ProjectCatalog } from "./projects.ts";
import type { DeployRepo } from "./repo.ts";
import type { SourceHost } from "./source.ts";
import type { ObjectStore } from "./store.ts";

export interface Ports {
  /** The Kubernetes API. Provided by the composition root, not by a plugin. */
  kube: KubeStreamClient;
  /** This region's database (regional tables). Provided by the composition root. */
  database: Database;
  /** The global database (global tables). The same as `database` until there are several regions. */
  globalDatabase: Database;
  /** Where sagas are kept between steps. Provided by the composition root. */
  sagas: SagaStore;
  /** Memory for the guards (used tickets, recent reveals). Provided by the composition root. */
  guards: GuardStore;
  /** Projects and their components, read-only. Provided by the composition root. */
  projects: ProjectCatalog;
  source: SourceHost;
  deployRepo: DeployRepo;
  cipher: SecretCipher;
  builder: Builder;
  /** Where builds are pushed; available without the Kubernetes API. */
  images: ImageNaming;
  identity: IdentityProvider;
  /** Pod log sources by name, e.g. `kube` (live) and `loki` (history). */
  logs: Record<string, LogSource>;
  /** Object storage for what outlives the cluster, such as build logs. */
  store: ObjectStore;
  /** DNS providers by name, e.g. `cloudflare` and `parallax`. */
  dns: Record<string, DnsProvider>;
  /** Database engines by name, e.g. `statefulset`. */
  databases: Record<string, DatabaseProvider>;
  /** Cloud instances by account name, e.g. `vultr`. */
  compute: Record<string, ComputeProvider>;
  /** Systems told about instances coming and going, by name. */
  instanceHooks: Record<string, InstanceHook>;
  /** Releases outside Kubernetes, by pipeline letter, e.g. `W` (Cloudflare Workers). */
  deployTargets: Record<string, DeployTarget>;
  /** Secret env values on a project's layers, provided by the server. */
  projectEnv: ProjectEnv;
}

export type PortName = keyof Ports;

export const PORT_NAMES: readonly PortName[] = [
  "kube",
  "database",
  "globalDatabase",
  "sagas",
  "guards",
  "projects",
  "source",
  "deployRepo",
  "cipher",
  "builder",
  "images",
  "identity",
  "logs",
  "store",
  "dns",
  "databases",
  "compute",
  "instanceHooks",
  "deployTargets",
  "projectEnv",
];

/**
 * Ports that more than one plugin may provide at once, each under its own
 * name (two DNS providers, say). Their value in `Ports` is a record keyed by
 * instance name.
 */
export const MULTI_PORTS: ReadonlySet<PortName> = new Set<PortName>([
  "logs",
  "dns",
  "databases",
  "deployTargets",
  "compute",
  "instanceHooks",
]);

export * from "./builder.ts";
export * from "./cipher.ts";
export * from "./compute.ts";
export * from "./database.ts";
export * from "./databases.ts";
export * from "./deploy-target.ts";
export * from "./dns.ts";
export * from "./identity.ts";
export * from "./instance-hooks.ts";
export * from "./kube.ts";
export * from "./logs.ts";
export * from "./project-env.ts";
export * from "./projects.ts";
export * from "./repo.ts";
export * from "./source.ts";
export * from "./store.ts";
