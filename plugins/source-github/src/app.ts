/**
 * GitHub App authentication for reading source: a token for one repository
 * at a time, with read access to its contents and nothing else.
 *
 * The App is meant to be its own, installed only on the private
 * repositories stardust builds, and kept apart from any App that writes the
 * deploy repository: a leaked key then opens reading, never writing.
 *
 * A public repository needs no token. A private one the App is not installed
 * on is refused, rather than cloned anonymously and failing later.
 */
import { createSign } from "node:crypto";
import type { RepoAccess } from "@stardust/core";

export interface GitHubAppOptions {
  appId: number;
  /** The App's private key, PEM. */
  privateKey: string;
  apiBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

export function githubApp(options: GitHubAppOptions) {
  const fetchFn = options.fetch ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const tokens = new Map<string, { token: string; until: number }>();

  /** The App's own short-lived JWT (RS256), for asking about installations. */
  const jwt = () => {
    const t = Math.floor(now() / 1000);
    // Issued a minute back for clock drift, valid under GitHub's ten-minute limit.
    const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: t - 60, exp: t + 540, iss: String(options.appId) }))}`;
    const signature = createSign("RSA-SHA256").update(input).sign(options.privateKey);
    return `${input}.${b64url(signature)}`;
  };
  const call = (path: string, init: RequestInit & { auth?: string } = {}) =>
    fetchFn(`${base}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

  /** A token for this repository only (contents and metadata, read), or null when the App is not installed on it. */
  async function tokenFor(repo: string): Promise<string | null> {
    const cached = tokens.get(repo);
    if (cached && cached.until > now()) return cached.token;
    const app = jwt();
    const found = await call(`/repos/${repo}/installation`, { auth: app });
    if (found.status === 404) return null;
    if (!found.ok) throw new Error(`GitHub answered ${found.status} looking for the App's installation on ${repo}`);
    const { id } = (await found.json()) as { id: number };
    const name = repo.split("/")[1] ?? repo;
    const made = await call(`/app/installations/${id}/access_tokens`, {
      method: "POST",
      auth: app,
      body: JSON.stringify({ repositories: [name], permissions: { contents: "read", metadata: "read" } }),
    });
    if (!made.ok) throw new Error(`GitHub answered ${made.status} making a token for ${repo}`);
    const { token, expires_at } = (await made.json()) as { token: string; expires_at: string };
    // Kept until five minutes before it expires, so a build never starts with one about to end.
    tokens.set(repo, { token, until: new Date(expires_at).getTime() - 5 * 60_000 });
    return token;
  }

  async function isPublic(repo: string): Promise<boolean> {
    const res = await call(`/repos/${repo}`);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
    return ((await res.json()) as { private?: boolean }).private === false;
  }

  return {
    tokenFor,
    /** Whether the App reads this repository (and how widely it is installed), else whether it is public. */
    async access(repo: string): Promise<RepoAccess> {
      const found = await call(`/repos/${repo}/installation`, { auth: jwt() });
      if (found.ok) {
        const { repository_selection } = (await found.json()) as { repository_selection?: string };
        return { readable: "app", installation: repository_selection === "all" ? "all" : "selected" };
      }
      if (found.status !== 404) {
        throw new Error(`GitHub answered ${found.status} looking for the App's installation on ${repo}`);
      }
      return { readable: (await isPublic(repo)) ? "public" : "none" };
    },
    /** What a build clones with: a token for the repository, none for a public one; never anonymous for a private one. */
    async cloneToken(repo: string): Promise<string | null> {
      const token = await tokenFor(repo);
      if (token) return token;
      if (await isPublic(repo)) return null;
      throw new Error(
        `the GitHub App is not installed on ${repo}: install it there, or the repository cannot be built`,
      );
    },
  };
}
