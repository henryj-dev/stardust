/**
 * Which webhook events are ignored, as a table rather than as branches in two
 * handlers — so "what does each kind of hook check?" can be read in one place.
 *
 * - `repo`: a project's own repository. Every check is on.
 * - `workspace`: a repository shared by several projects. Self-commit and fork
 *   checks are off; turning them on could reject events that arrive today and
 *   needs its own decision.
 */
export interface WebhookPolicy {
  /** Ignore events for projects marked disabled. */
  skipDisabled: boolean;
  /** Ignore commits stardust itself wrote to a deploy repository. */
  skipSelfCommit: boolean;
  /** Ignore pushes whose head commit asks to skip CI. */
  skipCi: boolean;
  /** Refuse pull requests from forks: builds run with cluster credentials. */
  judgeForkPr: boolean;
}

export const POLICY = {
  repo: { skipDisabled: true, skipSelfCommit: true, skipCi: true, judgeForkPr: true },
  workspace: { skipDisabled: true, skipSelfCommit: false, skipCi: true, judgeForkPr: false },
} as const satisfies Record<"repo" | "workspace", WebhookPolicy>;

export type WebhookKind = keyof typeof POLICY;

/**
 * Commits stardust writes to a deploy repository (`chore(<project>/<component>):
 * image -> …` and `… env -> …`). Building on them would commit again and loop.
 */
export const SELF_COMMIT_RE = /^chore\([^/]+\/[^)]+\): (image|env) -> /;

/** `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip build]`, `***NO_CI***`, any case. */
export const SKIP_CI_RE = /\[(skip ci|ci skip|no ci|skip ?build)\]|\*\*\*NO_CI\*\*\*/i;

export const REASON_SELF_COMMIT = "stardust self-commit to a deploy repository";
export const REASON_SKIP_CI = "[skip ci] marker in the head commit message";

/** Judges a push by its head commit message, applying only the checks the policy enables. */
export function judgePush(headMessage: string, policy: WebhookPolicy): { reason: string } | null {
  if (policy.skipSelfCommit && SELF_COMMIT_RE.test(headMessage)) return { reason: REASON_SELF_COMMIT };
  if (policy.skipCi && SKIP_CI_RE.test(headMessage)) return { reason: REASON_SKIP_CI };
  return null;
}

/** Only the boolean `true` disables a project; the string "true" does not. */
export function isProjectDisabled(metadata: unknown): boolean {
  return typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>).disabled === true;
}
