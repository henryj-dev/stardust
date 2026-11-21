/**
 * ClusterRoles bound to a component's own service account, such as
 * `system:auth-delegator` for an app that checks its callers' tokens with a
 * TokenReview. A ClusterRoleBinding grants across the whole cluster, not one
 * namespace, so only roles an administrator listed in the configuration can
 * be bound, and only by an administrator.
 *
 * The bindings live in `stardust-cluster-roles.yaml` next to the component's
 * manifests, listed in its kustomization, so withdrawing the component
 * removes them. Each is named after the namespace, the component and the
 * role, so two components never write the same object.
 */
import { parseAllDocuments, stringify } from "yaml";
import { WorkloadEditError } from "../runtime/workloads.ts";
import { addResource, removeResource } from "./kustomization.ts";
import { CLUSTER_ROLES_FILE, readDirectoryWorkload, serviceAccountName, workloadNamespace } from "./workload.ts";

export { CLUSTER_ROLES_FILE } from "./workload.ts";

/** A ClusterRole name as RBAC takes it (`system:auth-delegator`, `view`, `example.com:reader`). */
const ROLE = /^[a-z0-9]([a-z0-9:._-]{0,251}[a-z0-9])?$/;
export const isClusterRoleName = (v: unknown): v is string => typeof v === "string" && ROLE.test(v);

/** The binding's name: unique per namespace, component and role, at most 253 characters. */
export function clusterRoleBindingName(namespace: string, component: string, role: string): string {
  const slug = role.replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `stardust-${namespace}-${component}-${slug}`.slice(0, 253).replace(/[-.]+$/, "");
}

export function clusterRolesDocument(input: {
  component: string;
  namespace: string;
  roles: readonly string[];
}): string {
  const docs = [...new Set(input.roles)].sort().map((role) =>
    stringify({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: {
        name: clusterRoleBindingName(input.namespace, input.component, role),
        labels: { "app.kubernetes.io/part-of": input.component, "app.kubernetes.io/managed-by": "stardust" },
      },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: role },
      subjects: [{ kind: "ServiceAccount", name: serviceAccountName(input.component), namespace: input.namespace }],
    }),
  );
  return `# Cluster-wide: each binding grants its ClusterRole to ${input.component}'s service account
# across the whole cluster, not only in ${input.namespace}. Set by an administrator on the
# component's page, from the roles the configuration allows (runtime.allowedClusterRoles).
${docs.join("---\n")}`;
}

/** The ClusterRoles a bindings file grants. */
export function readClusterRoles(text: string): string[] {
  const roles: string[] = [];
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0 || doc.get("kind") !== "ClusterRoleBinding") continue;
    const name = doc.getIn(["roleRef", "name"]);
    if (typeof name === "string") roles.push(name);
  }
  return [...new Set(roles)].sort();
}

/**
 * The changes (path → text, or null to delete) that bind exactly these roles
 * to the component's service account: the bindings file and its list entry,
 * for one commit. Checking the roles against the allowed ones is the
 * caller's: this only renders.
 */
export function planClusterRoles(
  files: ReadonlyMap<string, string>,
  input: { dir: string; component: string; roles: readonly string[] },
): Map<string, string | null> {
  const dir = input.dir.replace(/\/+$/, "");
  const path = `${dir}/${CLUSTER_ROLES_FILE}`;
  const out = new Map<string, string | null>();
  const kustomization = ["kustomization.yaml", "kustomization.yml"].map((k) => `${dir}/${k}`).find((p) => files.has(p));
  const on = input.roles.length > 0;
  if (on) {
    for (const r of input.roles)
      if (!isClusterRoleName(r)) throw new WorkloadEditError(`${r} is not a ClusterRole name`);
    const { settings } = readDirectoryWorkload(files, input.component);
    if (!settings?.serviceAccount) {
      throw new WorkloadEditError(
        `${input.component} does not run as its own service account: turn it on in the Workload section first`,
      );
    }
    const ns = workloadNamespace(files, dir);
    if (typeof ns !== "string") throw new WorkloadEditError(ns.error);
    if (!kustomization)
      throw new WorkloadEditError(`${dir} has no kustomization.yaml to list ${CLUSTER_ROLES_FILE} in`);
    const text = clusterRolesDocument({ component: input.component, namespace: ns, roles: input.roles });
    if (files.get(path) !== text) out.set(path, text);
  } else if (files.has(path)) {
    out.set(path, null);
  }
  if (kustomization) {
    const listing = files.get(kustomization) ?? "";
    let next: string;
    try {
      next = on ? addResource(listing, CLUSTER_ROLES_FILE) : removeResource(listing, CLUSTER_ROLES_FILE);
    } catch (err) {
      throw new WorkloadEditError(`${kustomization}: ${(err as Error).message}`);
    }
    if (next !== listing) out.set(kustomization, next);
  }
  return out;
}
