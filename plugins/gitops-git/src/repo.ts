/**
 * The deploy repository, as the GitOps writer sees it. Implementations talk to
 * a Git host; tests use a fake. Everything that writes goes through
 * commitWithCas, which is what makes concurrent writers safe.
 */

export interface RepoFile {
  content: string;
  /** Blob SHA, so a writer can tell whether a file changed. */
  sha: string;
}

/** Path → new content, or null to delete the file. */
export type PendingCommit = Map<string, string | null>;

export type CommitErrorKind =
  /** The branch moved since `expectedHead` was read. Re-plan and retry. */
  | "stale_head"
  /** Another writer updated the ref between our commit and the ref update. Retry. */
  | "ref_race"
  /** Anything else; retrying will not help. */
  | "other";

export type CommitResult =
  | { status: "committed"; sha: string }
  | { status: "no_change" }
  | { status: "error"; kind: CommitErrorKind; message: string };

export interface RepoIO {
  /** The branch tip. Reads for a commit must use this exact SHA. */
  headSha(): Promise<string>;
  /** Reads a file at a commit. Null when it does not exist. */
  readFile(path: string, ref: string): Promise<RepoFile | null>;
  /** Lists file names directly inside a directory at a commit. */
  listDir(path: string, ref: string): Promise<string[]>;
  /**
   * Writes every change as one commit on top of `expectedHead`. If the branch
   * is no longer at `expectedHead`, nothing is written and the result is a
   * `stale_head` error.
   */
  commit(files: PendingCommit, message: string, expectedHead: string): Promise<CommitResult>;
}

export function isRetryable(result: CommitResult): boolean {
  return result.status === "error" && (result.kind === "stale_head" || result.kind === "ref_race");
}
