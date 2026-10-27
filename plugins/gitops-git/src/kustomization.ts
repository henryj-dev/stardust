/**
 * Editing the `resources:` list of a kustomization.yaml.
 *
 * kustomize builds only what the list names. A file not in the list is
 * silently ignored (and Flux still reports Ready); a list entry without its
 * file breaks the build of the whole Kustomization. So a file and its list
 * entry must change in the same commit — callers add both to one
 * PendingCommit — and this editing has to be exact.
 *
 * This is not a YAML round-trip: these files carry comments that people rely
 * on, and parsing then serialising would drop them. Lines are inserted and
 * removed in place.
 *
 * Indentation is read from the file, never assumed. A block sequence may sit
 * at column 0 directly under `resources:`, and a column-0 comment does not end
 * the list. Assuming two-space items once inserted a two-space item into a
 * column-0 list, which broke the sequence and stopped every deployment.
 */

const ITEM = /^(\s*)-\s+(\S+)\s*$/;
const COMMENT = /^\s*#/;
const BLANK = /^\s*$/;
const RESOURCES = /^resources:\s*$/;

/** Entries of `resources:`, in order; comments and blank lines are skipped. */
export function listResources(yaml: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const line of yaml.split("\n")) {
    if (RESOURCES.test(line)) {
      inList = true;
      continue;
    }
    if (!inList || BLANK.test(line) || COMMENT.test(line)) continue;
    const item = ITEM.exec(line);
    if (item) {
      out.push(item[2] as string);
      continue;
    }
    if (/^\S/.test(line)) break; // the next top-level key
  }
  return out;
}

/** Adds an entry after the last one, with the same indentation. No-op if present. */
export function addResource(yaml: string, entry: string): string {
  if (listResources(yaml).includes(entry)) return yaml;
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => RESOURCES.test(line));
  if (start < 0) throw new Error("kustomization.yaml has no `resources:` list");

  let lastItem = -1;
  let indent: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (BLANK.test(line) || COMMENT.test(line)) continue;
    const item = ITEM.exec(line);
    if (item) {
      lastItem = i;
      indent = item[1] as string;
      continue;
    }
    if (/^\S/.test(line)) break;
  }
  // Two spaces only when the list is empty and there is nothing to copy.
  lines.splice(lastItem >= 0 ? lastItem + 1 : start + 1, 0, `${indent ?? "  "}- ${entry}`);
  return lines.join("\n");
}

/**
 * Removes an entry. No-op if absent. Comments are kept: which comment belongs
 * to which entry cannot be told, and a leftover comment is harmless.
 */
export function removeResource(yaml: string, entry: string): string {
  const exact = new RegExp(`^\\s*-\\s+${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  let inList = false;
  const kept: string[] = [];
  for (const line of yaml.split("\n")) {
    if (RESOURCES.test(line)) {
      inList = true;
      kept.push(line);
      continue;
    }
    if (inList) {
      if (exact.test(line)) continue;
      // Items may sit at column 0, so `^\S` alone would end the list at its first item.
      if (/^\S/.test(line) && !COMMENT.test(line) && !ITEM.test(line)) inList = false;
    }
    kept.push(line);
  }
  return kept.join("\n");
}
