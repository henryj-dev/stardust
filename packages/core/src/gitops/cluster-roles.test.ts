import assert from "node:assert/strict";
import { it } from "node:test";
import { parseAllDocuments } from "yaml";
import { WorkloadEditError } from "../runtime/workloads.ts";
import {
  CLUSTER_ROLES_FILE,
  clusterRoleBindingName,
  isClusterRoleName,
  planClusterRoles,
  readClusterRoles,
} from "./cluster-roles.ts";
import { listResources } from "./kustomization.ts";
import { scaffoldComponent } from "./scaffold.ts";
import { planWorkload } from "./workload.ts";

const DIR = "deploy/demo/server";
const apply = (files: Map<string, string>, changes: Map<string, string | null>) => {
  const out = new Map(files);
  for (const [p, t] of changes) {
    if (t === null) out.delete(p);
    else out.set(p, t);
  }
  return out;
};
const base = () =>
  new Map(
    [
      ...scaffoldComponent({
        project: "demo",
        component: "server",
        namespace: "demo",
        imageRepository: "registry.example.com/demo/server",
      }),
    ].map(([k, v]) => [`${DIR}/${k}`, v]),
  );
const withAccount = () => {
  const files = base();
  return apply(files, planWorkload(files, { dir: DIR, component: "server", change: { serviceAccount: true } }));
};

it("binds the roles to the component's own account, cluster-wide, listed in the same change", () => {
  const files = withAccount();
  const out = apply(
    files,
    planClusterRoles(files, { dir: DIR, component: "server", roles: ["system:auth-delegator"] }),
  );
  const text = out.get(`${DIR}/${CLUSTER_ROLES_FILE}`) ?? "";
  assert.match(text, /^# Cluster-wide/);
  const [crb] = parseAllDocuments(text).map((d) => d.toJS());
  assert.deepEqual(crb, {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: {
      name: "stardust-demo-server-system-auth-delegator",
      labels: { "app.kubernetes.io/part-of": "server", "app.kubernetes.io/managed-by": "stardust" },
    },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "system:auth-delegator" },
    subjects: [{ kind: "ServiceAccount", name: "server", namespace: "demo" }],
  });
  assert.ok(listResources(out.get(`${DIR}/kustomization.yaml`) ?? "").includes(CLUSTER_ROLES_FILE));
  assert.deepEqual(readClusterRoles(text), ["system:auth-delegator"]);
  assert.equal(planClusterRoles(out, { dir: DIR, component: "server", roles: ["system:auth-delegator"] }).size, 0);

  const none = apply(out, planClusterRoles(out, { dir: DIR, component: "server", roles: [] }));
  assert.equal(none.has(`${DIR}/${CLUSTER_ROLES_FILE}`), false);
  assert.equal(listResources(none.get(`${DIR}/kustomization.yaml`) ?? "").includes(CLUSTER_ROLES_FILE), false);
});

it("needs the component's own account, and keeps it while roles are bound", () => {
  assert.throws(
    () => planClusterRoles(base(), { dir: DIR, component: "server", roles: ["view"] }),
    (e: Error) => e instanceof WorkloadEditError && /own service account/.test(e.message),
  );
  const files = withAccount();
  const bound = apply(files, planClusterRoles(files, { dir: DIR, component: "server", roles: ["view"] }));
  assert.throws(
    () => planWorkload(bound, { dir: DIR, component: "server", change: { serviceAccount: false } }),
    /cluster roles bound/,
  );
});

it("names bindings apart per namespace, component and role", () => {
  assert.notEqual(clusterRoleBindingName("a", "server", "view"), clusterRoleBindingName("b", "server", "view"));
  assert.notEqual(clusterRoleBindingName("a", "server", "view"), clusterRoleBindingName("a", "web", "view"));
  assert.ok(isClusterRoleName("system:auth-delegator"));
  assert.equal(isClusterRoleName("Cluster Admin"), false);
});
