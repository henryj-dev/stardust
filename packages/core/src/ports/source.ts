/**
 * The source host: where a project's code lives. A run asks it which commit
 * to build; the build itself clones on its own (see the builder).
 */

/** What an operator asks to pull: the default branch, or one branch, tag or commit. */
export type PullTarget = { branch: string } | { tag: string } | { sha: string } | Record<string, never>;

/** The commit a pull builds, and the ref it is recorded under. */
export interface ResolvedTarget {
  ref: string;
  sha: string;
}

/** Why a target could not be resolved. `notFound` is the operator's mistake; anything else is the host's. */
export class TargetError extends Error {
  readonly notFound: boolean;

  constructor(message: string, notFound: boolean) {
    super(message);
    this.name = "TargetError";
    this.notFound = notFound;
  }
}

export interface SourceHost {
  /** The commit a manual run builds. Throws TargetError. */
  resolveTarget(repo: string, target: PullTarget): Promise<ResolvedTarget>;
}
