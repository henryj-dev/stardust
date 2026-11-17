/**
 * What a component's namespace needs from the cluster beyond its own
 * manifests, kept next to them so withdrawing the component removes it too:
 *
 * - a registry pull Secret, so its pods can pull the images stardust builds
 *   from a registry that asks for a login. One credential, kept in
 *   stardust's configuration, is sealed into each component's directory;
 *   changing it reseals them all in one commit.
 * - a RoleBinding that lets stardust's server read the namespace (pods, logs,
 *   events, workloads, Services) for the dashboard. The role is a read-only
 *   ClusterRole the chart ships; it is bound per namespace, never cluster-wide.
 */
import { type Document, isMap, isSeq, parseAllDocuments, stringify, type YAMLMap } from "yaml";

/** The sealed pull Secret in a component's directory. */
export const REGISTRY_PULL_FILE = "registry-pull.secret.enc.yaml";
/** The RoleBinding that lets stardust read the component's namespace. */
export const RUNTIME_ACCESS_FILE = "stardust-runtime.rolebinding.yaml";

export const registryPullSecretName = (component: string) => `${component}-registry-pull`;
export const runtimeBindingName = (component: string) => `stardust-runtime-${component}`;

export interface RegistryLogin {
  /** The registry host (and port), as images name it: `registry.example.com`. */
  host: string;
  username: string;
  password: string;
}

/** The plain Secret a pod pulls with; the caller seals it before it is committed. */
export function registryPullDocument(input: { component: string; namespace: string; login: RegistryLogin }): string {
  const { host, username, password } = input.login;
  const auth = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  const config = JSON.stringify({ auths: { [host]: { username, password, auth } } });
  return stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: registryPullSecretName(input.component), namespace: input.namespace },
    type: "kubernetes.io/dockerconfigjson",
    stringData: { ".dockerconfigjson": config },
  });
}

export interface RuntimeGrant {
  /** The read-only ClusterRole the chart ships. */
  clusterRole: string;
  /** The server's service account. */
  serviceAccount: string;
  serviceAccountNamespace: string;
}

export function runtimeBindingDocument(input: { component: string; namespace: string; grant: RuntimeGrant }): string {
  return `# Lets stardust's server read this namespace for its dashboard: pods, their logs,
# events, workloads and Services. Read-only; it never reads Secrets.
${stringify({
  apiVersion: "rbac.authorization.k8s.io/v1",
  kind: "RoleBinding",
  metadata: { name: runtimeBindingName(input.component), namespace: input.namespace },
  roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: input.grant.clusterRole },
  subjects: [
    { kind: "ServiceAccount", name: input.grant.serviceAccount, namespace: input.grant.serviceAccountNamespace },
  ],
})}`;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

const podSpecs = (text: string) => {
  const docs = parseAllDocuments(text);
  const specs: Array<{ doc: Document; spec: YAMLMap }> = [];
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new Error(`cannot parse manifest: ${doc.errors[0]?.message}`);
    if (!WORKLOADS.has(String(doc.get("kind")))) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (isMap(spec)) specs.push({ doc, spec });
  }
  return { docs, specs };
};

const pullNames = (spec: YAMLMap): string[] => {
  const list = spec.get("imagePullSecrets", true);
  if (!isSeq(list)) return [];
  return list.items.flatMap((item) =>
    isMap(item) && typeof item.get("name") === "string" ? [String(item.get("name"))] : [],
  );
};

/** The pull Secrets a manifest's workloads name. */
export function readPullSecrets(text: string): string[] {
  return [...new Set(podSpecs(text).specs.flatMap((s) => pullNames(s.spec)))];
}

/**
 * Adds or removes one pull Secret in every workload of a manifest, leaving
 * the others it names and the rest of each document as they are.
 */
export function setPullSecret(
  text: string,
  secretName: string,
  on: boolean,
): { text: string; workloads: number; changed: boolean } {
  const { docs, specs } = podSpecs(text);
  let changed = false;
  for (const { doc, spec } of specs) {
    const names = pullNames(spec);
    if (on === names.includes(secretName)) continue;
    changed = true;
    const list = spec.get("imagePullSecrets", true);
    if (on) {
      const entry = { name: secretName };
      if (isSeq(list)) list.items.push(doc.createNode(entry));
      else spec.set("imagePullSecrets", doc.createNode([entry]));
    } else if (isSeq(list)) {
      list.items = list.items.filter((item) => !(isMap(item) && item.get("name") === secretName));
      if (list.items.length === 0) spec.delete("imagePullSecrets");
    }
  }
  if (!changed) return { text, workloads: specs.length, changed };
  const out = docs
    .map((d, i) => {
      const s = d.toString();
      return i > 0 && !s.startsWith("---") ? `---\n${s}` : s;
    })
    .join("");
  return { text: out, workloads: specs.length, changed };
}
