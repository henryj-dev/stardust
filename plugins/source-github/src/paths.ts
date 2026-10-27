/**
 * Changed paths of a push = the net change between `before` and `after`.
 *
 * The union of each commit's added/modified/removed lists is not the net
 * change: merging a branch that brings in commits already cherry-picked lists
 * files whose content did not change, and path-filtered jobs rebuild for
 * nothing. So the compare API is used, and the union only when compare cannot
 * be trusted — the union triggers more, never less, which is the safe side.
 */

/** GitHub's compare API returns at most this many files; at the limit the list may be cut. */
export const COMPARE_FILES_LIMIT = 300;

const FULL_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;

export interface CompareResult {
  files: Array<{ filename: string; previous_filename?: string }> | null;
}

export interface ChangedPaths {
  paths: string[];
  source: "compare" | "union";
  /** Why the union was used. Absent when compare was used. */
  fallback?: string;
}

type CommitLists = { added?: unknown; modified?: unknown; removed?: unknown } | null | undefined;

/** Union of the commits' file lists (and the head commit's). */
export function unionOfCommits(payload: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  const visit = (commit: CommitLists) => {
    for (const list of [commit?.added, commit?.modified, commit?.removed]) {
      if (Array.isArray(list)) for (const p of list) if (typeof p === "string") paths.add(p);
    }
  };
  if (Array.isArray(payload.commits)) for (const c of payload.commits) visit(c as CommitLists);
  visit(payload.head_commit as CommitLists);
  return [...paths];
}

export async function resolveChangedPaths(input: {
  payload: Record<string, unknown>;
  compare: (base: string, head: string) => Promise<CompareResult>;
}): Promise<ChangedPaths> {
  const { payload } = input;
  const union = (fallback: string): ChangedPaths => ({ paths: unionOfCommits(payload), source: "union", fallback });
  const before = typeof payload.before === "string" ? payload.before.toLowerCase() : "";
  const after = typeof payload.after === "string" ? payload.after.toLowerCase() : "";
  if (!FULL_SHA.test(before) || !FULL_SHA.test(after)) return union("before/after is not a full SHA");
  if (ZERO_SHA.test(before)) return union("before is zero: a new ref");
  if (ZERO_SHA.test(after)) return union("after is zero: a deleted ref");

  let result: CompareResult;
  try {
    result = await input.compare(before, after);
  } catch (err) {
    const reason = (err as { reason?: unknown })?.reason;
    return union(`compare failed${typeof reason === "string" ? ` (${reason})` : ""}`);
  }
  if (!result.files) return union("compare returned no files");
  if (result.files.length >= COMPARE_FILES_LIMIT) {
    return union(`compare returned ${result.files.length} files; the list may be cut`);
  }
  const paths = new Set<string>();
  for (const file of result.files) {
    paths.add(file.filename);
    if (file.previous_filename) paths.add(file.previous_filename);
  }
  return { paths: [...paths], source: "compare" };
}
