/**
 * A component's workloads, read from and written to its manifests in the
 * deploy repository: which Deployments, StatefulSets and DaemonSets it has,
 * and changes to their replicas or a container's resources. Edits go
 * through the YAML document API, so comments and the rest of the file stay.
 */
import { isMap, isSeq, parseAllDocuments } from "yaml";

export type RuntimeKind = "Deployment" | "StatefulSet" | "DaemonSet";
const KINDS = new Set<string>(["Deployment", "StatefulSet", "DaemonSet"]);

export interface Workload {
  kind: RuntimeKind;
  name: string;
  /** Null when the manifest leaves it to the kustomization or the controller. */
  namespace: string | null;
  /** `spec.selector.matchLabels`: how its pods are found. */
  selector: Record<string, string>;
  /** Null for a DaemonSet, or when the manifest does not set it. */
  replicas: number | null;
  containers: string[];
  /** The manifest file it is in. */
  file: string;
}

/** Every workload in the manifests of one directory (path → text). */
export function findWorkloads(files: ReadonlyMap<string, string>): Workload[] {
  const out: Workload[] = [];
  for (const [file, text] of files) {
    for (const doc of parseAllDocuments(text)) {
      if (doc.errors.length > 0) continue;
      const kind = doc.get("kind");
      const name = doc.getIn(["metadata", "name"]);
      if (typeof kind !== "string" || !KINDS.has(kind) || typeof name !== "string") continue;
      const labels = doc.getIn(["spec", "selector", "matchLabels"]);
      const selector: Record<string, string> = {};
      if (isMap(labels)) {
        for (const pair of labels.items) {
          const k = String((pair.key as { value?: unknown })?.value ?? pair.key);
          const v = (pair.value as { value?: unknown } | null)?.value;
          if (typeof v === "string" || typeof v === "number") selector[k] = String(v);
        }
      }
      const containers = doc.getIn(["spec", "template", "spec", "containers"]);
      const replicas = doc.getIn(["spec", "replicas"]);
      const namespace = doc.getIn(["metadata", "namespace"]);
      out.push({
        kind: kind as RuntimeKind,
        name,
        namespace: typeof namespace === "string" ? namespace : null,
        selector,
        replicas: typeof replicas === "number" ? replicas : null,
        containers: isSeq(containers)
          ? containers.items.flatMap((c) => {
              const n = isMap(c) ? c.get("name") : undefined;
              return typeof n === "string" ? [n] : [];
            })
          : [],
        file,
      });
    }
  }
  return out;
}

export class WorkloadEditError extends Error {}

/** Applies `edit` to the one workload named `kind/name` in `text`; throws when it is not there. */
function editWorkload(
  text: string,
  kind: RuntimeKind,
  name: string,
  edit: (doc: ReturnType<typeof parseAllDocuments>[number]) => boolean,
): { text: string; changed: boolean } {
  const docs = parseAllDocuments(text);
  let found = false;
  let changed = false;
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new WorkloadEditError(`cannot parse manifest: ${doc.errors[0]?.message}`);
    if (doc.get("kind") !== kind || doc.getIn(["metadata", "name"]) !== name) continue;
    found = true;
    changed = edit(doc) || changed;
  }
  if (!found) throw new WorkloadEditError(`no ${kind} ${name} in this manifest`);
  if (!changed) return { text, changed };
  const out = docs
    .map((d, i) => {
      const s = d.toString();
      return i > 0 && !s.startsWith("---") ? `---\n${s}` : s;
    })
    .join("");
  return { text: out, changed };
}

export const MAX_REPLICAS = 100;

export function setReplicas(
  text: string,
  kind: RuntimeKind,
  name: string,
  replicas: number,
): { text: string; changed: boolean } {
  if (kind === "DaemonSet") throw new WorkloadEditError("a DaemonSet runs one pod per node; it has no replicas");
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > MAX_REPLICAS) {
    throw new WorkloadEditError(`replicas must be a whole number from 0 to ${MAX_REPLICAS}`);
  }
  return editWorkload(text, kind, name, (doc) => {
    if (doc.getIn(["spec", "replicas"]) === replicas) return false;
    doc.setIn(["spec", "replicas"], replicas);
    return true;
  });
}

export interface Resources {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

// Kubernetes quantities: plain or with a decimal/binary suffix, e.g. 250m, 0.5, 512Mi, 1G.
const QUANTITY = /^(\d+(\.\d+)?|\.\d+)(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;

export function setResources(
  text: string,
  kind: RuntimeKind,
  name: string,
  container: string,
  resources: Resources,
): { text: string; changed: boolean } {
  for (const [group, values] of Object.entries(resources)) {
    if (group !== "requests" && group !== "limits") throw new WorkloadEditError(`unknown resource group "${group}"`);
    for (const [key, value] of Object.entries(values ?? {})) {
      if (key !== "cpu" && key !== "memory") throw new WorkloadEditError(`unknown resource "${key}"`);
      if (typeof value !== "string" || !QUANTITY.test(value)) {
        throw new WorkloadEditError(`${group}.${key} must be a Kubernetes quantity such as 250m or 512Mi`);
      }
    }
  }
  return editWorkload(text, kind, name, (doc) => {
    const containers = doc.getIn(["spec", "template", "spec", "containers"]);
    const index = isSeq(containers) ? containers.items.findIndex((c) => isMap(c) && c.get("name") === container) : -1;
    if (index < 0) throw new WorkloadEditError(`no container ${container} in ${kind} ${name}`);
    let changed = false;
    for (const group of ["requests", "limits"] as const) {
      for (const [key, value] of Object.entries(resources[group] ?? {})) {
        const path = ["spec", "template", "spec", "containers", index, "resources", group, key];
        if (doc.getIn(path) !== value) {
          doc.setIn(path, value);
          changed = true;
        }
      }
    }
    return changed;
  });
}
