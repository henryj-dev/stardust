/**
 * An address outside the cluster for an instance: a LoadBalancer Service
 * `<instance>-db` beside the one inside, with a fixed cluster IP and its
 * own load-balancer address at the same offset in two blocks of one size:
 *
 *   clusterIPs: 10.0.0.0/24   → the Service's clusterIP is 10.0.0.N
 *   addresses:  10.0.8.0/24   → its address outside is    10.0.8.N
 *
 * N is the smallest offset that no Service stardust can see holds in either
 * block. A cluster IP cannot change once a Service exists, so an instance's
 * own Service is left alone: this one is separate. Pure: the feature reads
 * the repository and the cluster, this decides and renders.
 */
import {
  type AddressSettings,
  addressSettingsProblems,
  type FixedAddress,
  isIPv4,
  renderLoadBalancer,
  servicesIn,
} from "@stardust/core";

export {
  addressesAt,
  addressesOf,
  type Blocks,
  blocksOf,
  isIPv4,
  pickOffset,
  servicesIn,
  servicesInList,
  usedOffsets,
} from "@stardust/core";

/** The blocks and the Services' shape (see @stardust/core gitops/addresses). */
export type ExternalSettings = AddressSettings;
export type ExternalAddress = FixedAddress;
/** Why a settings section cannot be used, or nothing. */
export const externalProblems = addressSettingsProblems;

/** Where an instance's own address outside lives in its directory. */
export const EXTERNAL_FILE = "db.service.yaml";
export const externalServiceName = (instance: string) => `${instance}-db`;
export const POSTGRES_PORT = 5432;

const split = (v: unknown) =>
  typeof v === "string"
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/** The address outside a file gives `<instance>-db`, or null when it has none stardust can read. */
export function readExternal(text: string, instance: string, addressAnnotation: string): ExternalAddress | null {
  const svc = servicesIn(text).find((o) => o.metadata?.name === externalServiceName(instance));
  if (!svc) return null;
  const address =
    split(svc.metadata?.annotations?.[addressAnnotation]).find(isIPv4) ?? split(svc.spec?.loadBalancerIP).find(isIPv4);
  if (!address) return null;
  const clusterIP = split(svc.spec?.clusterIP).find(isIPv4) ?? null;
  return { clusterIP, address };
}

export interface ExternalService {
  instance: string;
  namespace: string;
  /** The labels of the instance's pods. */
  selector: Record<string, string>;
  clusterIP: string;
  address: string;
}

/** The Service, as an admission policy holds it (see renderLoadBalancer). */
export function renderExternalService(s: ExternalSettings, svc: ExternalService): string {
  return renderLoadBalancer(s, {
    name: externalServiceName(svc.instance),
    namespace: svc.namespace,
    selector: svc.selector,
    clusterIP: svc.clusterIP,
    address: svc.address,
    ports: [{ name: "postgres", port: POSTGRES_PORT, targetPort: POSTGRES_PORT, protocol: "TCP" }],
  });
}
