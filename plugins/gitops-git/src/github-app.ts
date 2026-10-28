/**
 * Authenticating to GitHub as a GitHub App, for pushing to a deploy
 * repository without a person's token.
 *
 * The App's private key signs a short JWT (RS256); with it the installation
 * on the repository is looked up, and an installation token is requested
 * that is narrowed to that one repository and to `contents: write` only,
 * whatever else the installation may grant. Tokens last an hour; one is
 * reused until a few minutes before it expires.
 */
import { createPrivateKey, sign } from "node:crypto";

export interface GitHubAppOptions {
  appId: number;
  /** The App's private key, PEM. */
  privateKey: string;
  /** owner/name of the repository the token is for. */
  repo: string;
  /** Defaults to https://api.github.com. */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  /** Seconds since the epoch; for tests. */
  now?: () => number;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** A JWT that identifies the App for ten minutes, backdated a minute against clock drift. */
export function appJwt(appId: number, privateKey: string, now: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), createPrivateKey(privateKey));
  return `${header}.${payload}.${b64url(signature)}`;
}

/** The owner/name a GitHub https URL points at, or null. */
export function repoFromUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Returns a function that yields a valid installation token, fetching a new one when needed. */
export function installationTokens(options: GitHubAppOptions): () => Promise<string> {
  const base = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const [, name] = options.repo.split("/");
  createPrivateKey(options.privateKey); // fail at start-up, not at the first push, on a bad key
  let cached: { token: string; expiresAt: number } | null = null;
  let installationId: number | null = null;
  let pending: Promise<string> | null = null;

  const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${appJwt(options.appId, options.privateKey, now())}`,
        accept: "application/vnd.github+json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const hint = res.status === 404 && path.endsWith("/installation") ? ": is the App installed on it?" : "";
      throw new Error(`GitHub App: ${method} ${path} answered ${res.status}${hint}`);
    }
    return (await res.json()) as Record<string, unknown>;
  };

  const refresh = async (): Promise<string> => {
    if (installationId === null) {
      const found = await call("GET", `/repos/${options.repo}/installation`);
      if (typeof found.id !== "number") throw new Error(`GitHub App: no installation id for ${options.repo}`);
      installationId = found.id;
    }
    const issued = await call("POST", `/app/installations/${installationId}/access_tokens`, {
      repositories: [name],
      permissions: { contents: "write" },
    });
    const expiresAt = typeof issued.expires_at === "string" ? Date.parse(issued.expires_at) / 1000 : Number.NaN;
    if (typeof issued.token !== "string" || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub App: the token response has no token or expiry");
    }
    cached = { token: issued.token, expiresAt };
    return issued.token;
  };

  return async () => {
    // Reused until five minutes before it expires, so a push never starts with a dying token.
    if (cached && cached.expiresAt - now() > 300) return cached.token;
    // One refresh at a time: concurrent pushes share it.
    pending ??= refresh().finally(() => {
      pending = null;
    });
    return pending;
  };
}
