/**
 * The runtime plugin's settings:
 *
 *   runtime:
 *     allowedClusterRoles: [system:auth-delegator]   # optional: roles a component's account may be bound to
 */
import { isClusterRoleName } from "@stardust/core";

export interface RuntimeSettings {
  /** ClusterRoles an administrator may bind to a component's own service account. */
  allowedClusterRoles?: string[];
}

const KEYS = ["allowedClusterRoles"];

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
  return problems;
}
