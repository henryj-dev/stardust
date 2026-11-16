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
  /**
   * A short-lived token a build clones this repository with, good for it alone
   * (a GitHub App's); null for a public one. Throws for a private repository
   * it cannot read. Absent when the host gives none (a static clone secret is used).
   */
  cloneToken?(repo: string): Promise<string | null>;
  /** Whether stardust can read this repository, and how. Absent when the host cannot say. */
  access?(repo: string): Promise<RepoAccess>;
}

/**
 * How stardust reads a repository:
 * - `public`: anyone can, so builds clone it without a token;
 * - `app`: the GitHub App is installed on it;
 * - `token`: the configured token reads it;
 * - `none`: it cannot — private and not installed on, or no such repository.
 */
export interface RepoAccess {
  readable: "public" | "app" | "token" | "none";
  /**
   * With the App: whether its installation covers all of the owner's
   * repositories, or only the ones chosen. With `all`, a leaked key reads every one.
   */
  installation?: "all" | "selected";
}
