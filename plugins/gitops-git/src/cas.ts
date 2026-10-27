/**
 * Compare-and-swap commits: read the tip, plan the change from files read at
 * that tip, commit with the tip as the expected parent, and start over if the
 * tip moved. The plan receives a reader already bound to the tip, so reading a
 * file at a branch name — and planning against a stale view — cannot be
 * written by mistake.
 */
import { type CommitResult, isRetryable, type PendingCommit, type RepoFile, type RepoIO } from "./repo.ts";

export interface BoundRepo {
  read(path: string): Promise<RepoFile | null>;
  list(path: string): Promise<string[]>;
}

export interface CommitPlan {
  files: PendingCommit;
  message: string;
}

export interface CasOptions {
  attempts?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * @param plan returns the change to commit, or null when there is nothing to do.
 *   If it throws, the error propagates: a change that cannot be planned is not retried.
 * @returns the commit result. A non-retryable error is returned at once; when
 *   every attempt hit a moving tip, the last result is returned.
 */
export async function commitWithCas(
  repo: RepoIO,
  plan: (head: string, at: BoundRepo) => Promise<CommitPlan | null>,
  options: CasOptions = {},
): Promise<CommitResult> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const backoff = options.backoffMs ?? ((attempt) => 250 * 2 ** attempt);
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let last: CommitResult = { status: "no_change" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const head = await repo.headSha();
    const at: BoundRepo = { read: (path) => repo.readFile(path, head), list: (path) => repo.listDir(path, head) };
    const change = await plan(head, at);
    if (!change || change.files.size === 0) return { status: "no_change" };
    last = await repo.commit(change.files, change.message, head);
    if (!isRetryable(last)) return last;
    if (attempt < attempts - 1) await sleep(backoff(attempt));
  }
  return last;
}
