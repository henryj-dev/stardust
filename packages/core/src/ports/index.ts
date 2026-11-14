/**
 * Ports: what plugins provide and what the rest of stardust uses. A port is
 * a type here and an implementation in a plugin (or, for `kube`, in the
 * composition root), so a second implementation needs no change outside its
 * own plugin.
 */
import type { GuardStore } from "../guard.ts";
import type { SagaStore } from "../saga.ts";
import type { Builder } from "./builder.ts";
import type { SecretCipher } from "./cipher.ts";
import type { Database } from "./database.ts";
import type { IdentityProvider } from "./identity.ts";
import type { KubeStreamClient } from "./kube.ts";
import type { DeployRepo } from "./repo.ts";
import type { SourceHost } from "./source.ts";

export interface Ports {
  /** The Kubernetes API. Provided by the composition root, not by a plugin. */
  kube: KubeStreamClient;
  /** stardust's own database. Provided by the composition root. */
  database: Database;
  /** Where sagas are kept between steps. Provided by the composition root. */
  sagas: SagaStore;
  /** Memory for the guards (used tickets, recent reveals). Provided by the composition root. */
  guards: GuardStore;
  source: SourceHost;
  deployRepo: DeployRepo;
  cipher: SecretCipher;
  builder: Builder;
  identity: IdentityProvider;
}

export type PortName = keyof Ports;

export const PORT_NAMES: readonly PortName[] = [
  "kube",
  "database",
  "sagas",
  "guards",
  "source",
  "deployRepo",
  "cipher",
  "builder",
  "identity",
];

/**
 * Ports that more than one plugin may provide at once, each under its own
 * name (two DNS providers, say). Their value in `Ports` is a record keyed by
 * instance name. None exist yet.
 */
export const MULTI_PORTS: ReadonlySet<PortName> = new Set<PortName>();

export * from "./builder.ts";
export * from "./cipher.ts";
export * from "./database.ts";
export * from "./identity.ts";
export * from "./kube.ts";
export * from "./repo.ts";
export * from "./source.ts";
