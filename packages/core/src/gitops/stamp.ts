/**
 * Writes an annotation into the pod template of the workloads in a manifest,
 * so changing it rolls them out when the GitOps controller applies the
 * commit. This is how an environment change or a restart reaches running
 * pods: a restart done on the cluster directly (kubectl rollout restart) is
 * reverted by the controller as drift, while a template annotation committed
 * to Git is the desired state.
 *
 * The file is edited in place: the annotation's value is replaced where it
 * is, or one line (or a small block) is inserted, so comments, spacing and
 * flow collections elsewhere stay exactly as they were. Only a layout this
 * cannot place (flow-style metadata) falls back to re-printing the document.
 */
import { isMap, isScalar, parseAllDocuments, type YAMLMap } from "yaml";

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

interface Edit {
  at: number;
  end: number;
  text: string;
}

/** The column of a node, from its start offset. */
const columnOf = (text: string, offset: number) => offset - (text.lastIndexOf("\n", offset - 1) + 1);

/** Where a block map's last entry ends: the end of the line holding it. */
function endOfMap(text: string, map: YAMLMap): number | null {
  const last = map.items[map.items.length - 1];
  const node = last?.value ?? last?.key;
  const end = (node as { range?: [number, number, number] } | null)?.range?.[1];
  if (end === undefined) return null;
  // A nested block ends after its last newline: insert before that newline.
  let stop = end;
  while (stop > 0 && (text[stop - 1] === "\n" || text[stop - 1] === " ")) stop--;
  // A scalar may end mid-line before a comment: insert after that line.
  const newline = text.indexOf("\n", stop);
  return newline < 0 ? text.length : newline;
}

const keyStart = (map: YAMLMap) => (map.items[0]?.key as { range?: [number, number, number] } | null)?.range?.[0];

export function stampPodTemplate(
  text: string,
  annotation: string,
  value: string,
): { text: string; stamped: number; changed: boolean } {
  const docs = parseAllDocuments(text);
  const quoted = JSON.stringify(value);
  const edits: Edit[] = [];
  let stamped = 0;
  let fallback = false;
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new Error(`cannot parse manifest: ${doc.errors[0]?.message}`);
    const kind = doc.get("kind");
    if (typeof kind !== "string" || !WORKLOADS.has(kind)) continue;
    const template = doc.getIn(["spec", "template"], true);
    if (!isMap(template)) continue;
    stamped++;
    const current = doc.getIn(["spec", "template", "metadata", "annotations", annotation], true);
    if (isScalar(current) && current.range) {
      if (current.value !== value) edits.push({ at: current.range[0], end: current.range[1], text: quoted });
      continue;
    }
    const annotations = doc.getIn(["spec", "template", "metadata", "annotations"], true);
    const metadata = doc.getIn(["spec", "template", "metadata"], true);
    if (isMap(annotations) && !annotations.flow && annotations.items.length > 0) {
      const at = endOfMap(text, annotations);
      const start = keyStart(annotations);
      if (at === null || start === undefined) fallback = true;
      else edits.push({ at, end: at, text: `\n${" ".repeat(columnOf(text, start))}${annotation}: ${quoted}` });
    } else if (annotations === undefined && isMap(metadata) && !metadata.flow && metadata.items.length > 0) {
      const at = endOfMap(text, metadata);
      const start = keyStart(metadata);
      if (at === null || start === undefined) fallback = true;
      else {
        const pad = " ".repeat(columnOf(text, start));
        edits.push({ at, end: at, text: `\n${pad}annotations:\n${pad}  ${annotation}: ${quoted}` });
      }
    } else if (metadata === undefined && !template.flow && template.items.length > 0) {
      const start = keyStart(template);
      if (start === undefined) fallback = true;
      else {
        const pad = " ".repeat(columnOf(text, start));
        edits.push({
          at: start,
          end: start,
          text: `metadata:\n${pad}  annotations:\n${pad}    ${annotation}: ${quoted}\n${pad}`,
        });
      }
    } else {
      fallback = true;
    }
  }

  if (fallback) return reprint(text, annotation, value);
  if (edits.length === 0) return { text, stamped, changed: false };
  let out = text;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return { text: out, stamped, changed: true };
}

/** The old way, for layouts an in-place edit cannot place: set the value and print the documents again. */
function reprint(text: string, annotation: string, value: string): { text: string; stamped: number; changed: boolean } {
  const docs = parseAllDocuments(text);
  let stamped = 0;
  let changed = false;
  for (const doc of docs) {
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
  const out = docs
    .map((d, i) => {
      const s = d.toString();
      return i > 0 && !s.startsWith("---") ? `---\n${s}` : s;
    })
    .join("");
  return { text: out, stamped, changed };
}
