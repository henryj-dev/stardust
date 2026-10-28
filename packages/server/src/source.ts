import type { CompareResult } from "@stardust/plugin-source-github";

const headers = (token: string | undefined): Record<string, string> => ({
  accept: "application/vnd.github+json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/**
 * The compare API of GitHub (or a host that mirrors its shape). A response
 * without a `files` list — Gitea's, for one — yields `files: null`, which makes
 * the caller fall back to the commits' union: more builds, never fewer.
 * Without a token the request is anonymous, which is enough for public
 * repositories (at a lower rate limit).
 */
export function compareApi(apiBaseUrl: string, token: string | undefined, fetchFn: typeof fetch = fetch) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return async (repo: string, head1: string, head2: string): Promise<CompareResult> => {
    const res = await fetchFn(`${base}/repos/${repo}/compare/${head1}...${head2}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(`compare returned ${res.status}`), { reason: `http_${res.status}` });
    const body = (await res.json()) as { files?: unknown };
    if (!Array.isArray(body.files)) return { files: null };
    return {
      files: body.files
        .filter((f): f is { filename: string; previous_filename?: unknown } => typeof f?.filename === "string")
        .map((f) => ({
          filename: f.filename,
          ...(typeof f.previous_filename === "string" ? { previous_filename: f.previous_filename } : {}),
        })),
    };
  };
}

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

const SHA = /^[0-9a-f]{40}$/;

/**
 * Resolves a pull target to a commit through GitHub's REST API.
 *
 * A commit given by hash must be in the default branch's history. GitHub
 * answers for commits anywhere in a repository's fork network, so without
 * this check a hash pushed to someone's fork would build as if it were this
 * repository's. A branch or a tag names a ref of the repository itself.
 */
export function targetApi(apiBaseUrl: string, token: string | undefined, fetchFn: typeof fetch = fetch) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const get = async (path: string, what: string): Promise<Record<string, unknown>> => {
    const res = await fetchFn(`${base}/repos/${path}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 422) throw new TargetError(`${what} was not found`, true);
    if (!res.ok) throw new TargetError(`the source host answered ${res.status} for ${what}`, false);
    return (await res.json()) as Record<string, unknown>;
  };
  // Each segment is encoded on its own, so a branch like feature/x keeps its slash.
  const path = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  const commitSha = (body: Record<string, unknown>, what: string): string => {
    if (typeof body.sha !== "string" || !SHA.test(body.sha)) {
      throw new TargetError(`the source host gave no commit for ${what}`, false);
    }
    return body.sha;
  };
  const defaultBranch = async (repo: string): Promise<string> => {
    const body = await get(repo, `repository ${repo}`);
    if (typeof body.default_branch !== "string") throw new TargetError(`${repo} has no default branch`, false);
    return body.default_branch;
  };

  return async (repo: string, target: PullTarget): Promise<ResolvedTarget> => {
    if ("tag" in target) {
      const what = `tag ${target.tag}`;
      const sha = commitSha(await get(`${repo}/commits/tags/${path(target.tag)}`, what), what);
      return { ref: `refs/tags/${target.tag}`, sha };
    }
    if ("sha" in target) {
      const branch = await defaultBranch(repo);
      const what = `commit ${target.sha}`;
      const sha = commitSha(await get(`${repo}/commits/${target.sha}`, what), what);
      const compared = await get(`${repo}/compare/${path(branch)}...${sha}`, what);
      // "behind" or "identical": the commit is the branch's head or one of its ancestors.
      if (compared.status !== "behind" && compared.status !== "identical") {
        throw new TargetError(`commit ${target.sha} is not in the history of ${branch}`, true);
      }
      return { ref: `refs/heads/${branch}`, sha };
    }
    const branch = "branch" in target ? target.branch : await defaultBranch(repo);
    const what = `branch ${branch}`;
    const sha = commitSha(await get(`${repo}/commits/heads/${path(branch)}`, what), what);
    return { ref: `refs/heads/${branch}`, sha };
  };
}
