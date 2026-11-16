/**
 * Writes an annotation into the pod template of the workloads in a manifest,
 * so changing it rolls them out when the GitOps controller applies the
 * commit. This is how an environment change reaches running pods: a restart
 * done on the cluster directly (kubectl rollout restart) is reverted by the
 * controller as drift, while a template annotation committed to Git is the
 * desired state.
 *
 * Comments and formatting elsewhere in the file are kept (YAML document API,
 * not a re-serialisation of plain objects).
 */
import { isMap, parseAllDocuments } from "yaml";

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

export function stampPodTemplate(
  text: string,
  annotation: string,
  value: string,
): { text: string; stamped: number; changed: boolean } {
  const docs = parseAllDocuments(text);
  let stamped = 0;
  let changed = false;
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new Error(`cannot parse manifest: ${doc.errors[0]?.message}`);
    const kind = doc.get("kind");
    if (typeof kind !== "string" || !WORKLOADS.has(kind)) continue;
    if (!isMap(doc.getIn(["spec", "template"]))) continue;
    const path = ["spec", "template", "metadata", "annotations", annotation];
    if (doc.getIn(path) !== value) {
      doc.setIn(path, value);
      changed = true;
    }
    stamped++;
  }
  if (!changed) return { text, stamped, changed };
  // A document that began with an explicit "---" prints it again; add a separator only when it does not.
  const out = docs
    .map((d, i) => {
      const s = d.toString();
      return i > 0 && !s.startsWith("---") ? `---\n${s}` : s;
    })
    .join("");
  return { text: out, stamped, changed };
}
