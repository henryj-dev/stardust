/**
 * Detects pull requests from forks. A pull request builds its head commit, and
 * builds run with cluster credentials, so a fork's pull request would run
 * someone else's code with those credentials ("pwn request").
 *
 * The check fails closed: if the head repository cannot be read it counts as a
 * fork. GitHub sends `head.repo: null` when the fork was deleted — which means
 * it was a fork.
 */
export type ForkVerdict = { fork: false } | { fork: true; reason: string };

type Repo = { full_name?: unknown } | null | undefined;

function fullName(repo: Repo): string | null {
  const name = repo?.full_name;
  // Repository names are case-insensitive on GitHub.
  return typeof name === "string" && name.length > 0 ? name.toLowerCase() : null;
}

export function judgeForkPullRequest(payload: unknown): ForkVerdict {
  const pr = (payload as { pull_request?: { head?: { repo?: Repo }; base?: { repo?: Repo } } | null } | null)
    ?.pull_request;
  const head = fullName(pr?.head?.repo);
  const base = fullName(pr?.base?.repo);
  if (!base) return { fork: true, reason: "base.repo.full_name is missing; refusing" };
  if (!head) return { fork: true, reason: "head.repo is missing (deleted fork)" };
  if (head !== base) return { fork: true, reason: `head=${head} differs from base=${base}` };
  return { fork: false };
}
