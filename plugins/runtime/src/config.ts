/**
 * The runtime plugin's settings:
 *
 *   runtime:
 *     allowedClusterRoles: [system:auth-delegator]   # optional: roles a component's account may be bound to
 *     external:                   # optional: an address outside the cluster per component
 *       clusterIPs: 10.0.0.0/24   #   the fixed cluster IP is .N here …
 *       addresses: 10.0.8.0/24    #   … and the address outside the same .N here
 *       first: 10                 #   optional: the lowest and highest N to give out
 *       last: 200
 *       addressAnnotation: lbipam.cilium.io/ips
 *       labels: { example.com/pool: apps }
 *       annotations: { service.cilium.io/forwarding-mode: dsr }
 *       scan: [""]                #   where held addresses are read (default: the whole repository)
 */
import { type AddressSettings, addressSettingsProblems, isClusterRoleName } from "@stardust/core";

export interface RuntimeSettings {
  /** ClusterRoles an administrator may bind to a component's own service account. */
  allowedClusterRoles?: string[];
  /** Addresses outside the cluster for components, from these blocks. */
  external?: AddressSettings;
}

const KEYS = ["allowedClusterRoles", "external"];

/** Why a settings section cannot be used, or nothing. */
export function settingsProblems(section: unknown): string[] {
  if (typeof section !== "object" || section === null || Array.isArray(section)) return ["must be a mapping"];
  const s = section as Record<string, unknown>;
  const problems = Object.keys(s)
    .filter((k) => !KEYS.includes(k))
    .map((k) => `unknown key "${k}"`);
  if (s.allowedClusterRoles !== undefined) {
    if (!Array.isArray(s.allowedClusterRoles)) problems.push("allowedClusterRoles must be a list of ClusterRole names");
    else
      for (const r of s.allowedClusterRoles)
        if (!isClusterRoleName(r)) problems.push(`allowedClusterRoles: ${JSON.stringify(r)} is not a ClusterRole name`);
  }
  if (s.external !== undefined) for (const p of addressSettingsProblems(s.external)) problems.push(`external: ${p}`);
  return problems;
}
