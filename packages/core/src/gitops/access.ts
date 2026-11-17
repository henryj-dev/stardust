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
 * - an envFrom in each container, so the values set on the env page reach the
 *   process as environment variables. Both references are optional: a
 *   component without env values yet still starts.
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

const envRefs = (configMap: string, secret: string) => [
  { key: "configMapRef", name: configMap },
  { key: "secretRef", name: secret },
];

const containersOf = (spec: YAMLMap): YAMLMap[] => {
  const list = spec.get("containers", true);
  return isSeq(list) ? list.items.filter(isMap) : [];
};

const envFromNames = (container: YAMLMap, key: string): string[] => {
  const list = container.get("envFrom", true);
  if (!isSeq(list)) return [];
  return list.items.flatMap((item) => {
    if (!isMap(item)) return [];
    const ref = item.get(key, true);
    return isMap(ref) && typeof ref.get("name") === "string" ? [String(ref.get("name"))] : [];
  });
};

/**
 * Whether every container of every workload in a manifest reads the env
 * ConfigMap and Secret whole; null when the manifest runs no container.
 */
export function readsEnv(text: string, names: { configMap: string; secret: string }): boolean | null {
  const containers = podSpecs(text).specs.flatMap((s) => containersOf(s.spec));
  if (containers.length === 0) return null;
  return containers.every((c) =>
    envRefs(names.configMap, names.secret).every((r) => envFromNames(c, r.key).includes(r.name)),
  );
}

/**
 * Adds or removes the envFrom references to the env ConfigMap and Secret in
 * every container of every workload, leaving other envFrom entries, env and
 * the rest of each document as they are. Init containers are left alone.
 */
export function setEnvFrom(
  text: string,
  names: { configMap: string; secret: string },
  on: boolean,
): { text: string; workloads: number; changed: boolean } {
  const { docs, specs } = podSpecs(text);
  let changed = false;
  for (const { doc, spec } of specs) {
    for (const container of containersOf(spec)) {
      for (const ref of envRefs(names.configMap, names.secret)) {
        const has = envFromNames(container, ref.key).includes(ref.name);
        if (on === has) continue;
        changed = true;
        const list = container.get("envFrom", true);
        if (on) {
          const entry = { [ref.key]: { name: ref.name, optional: true } };
          if (isSeq(list)) list.items.push(doc.createNode(entry));
          else container.set("envFrom", doc.createNode([entry]));
        } else if (isSeq(list)) {
          list.items = list.items.filter((item) => {
            const r = isMap(item) ? item.get(ref.key, true) : null;
            return !(isMap(r) && r.get("name") === ref.name);
          });
          if (list.items.length === 0) container.delete("envFrom");
        }
      }
    }
  }
  return { text: changed ? printAll(docs) : text, workloads: specs.length, changed };
}

const printAll = (docs: Document[]) =>
  docs
    .map((d, i) => {
      const s = d.toString();
      return i > 0 && !s.startsWith("---") ? `---\n${s}` : s;
    })
    .join("");

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
  return { text: changed ? printAll(docs) : text, workloads: specs.length, changed };
}
