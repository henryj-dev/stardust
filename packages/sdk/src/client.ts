/**
 * HTTP client for the stardust API.
 *
 * Hand-written for now; it will be generated from the server's OpenAPI
 * document, and CI will fail when the two drift apart.
 */

export interface ClientOptions {
  readonly baseUrl: string;
  /** Admin bearer token, until user sign-in exists. */
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

export interface JobView {
  name: string;
  status: string;
  attempt: number;
  detail: Record<string, unknown>;
}

export interface RunView {
  id: string;
  event: string;
  trigger: string;
  ref: string;
  sha: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  jobs: JobView[];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; reason: "invalid" | "locked"; message: string };

export interface Client {
  health(): Promise<{ status: string; version: string }>;
  /** Signs in with a username and password. Wrong credentials and lockout are results, not errors. */
  login(username: string, password: string): Promise<LoginResult>;
  /** Ends the session of the client's token. */
  logout(): Promise<void>;
  /** True when the token is accepted. */
  checkToken(): Promise<boolean>;
  runs(projectId: string): Promise<RunView[]>;
  /** The raw server-sent event stream of a project's runs. */
  events(projectId: string, signal?: AbortSignal): Promise<Response>;
}

export function createClient(options: ClientOptions): Client {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const headers = (): Record<string, string> => (options.token ? { authorization: `Bearer ${options.token}` } : {});
  const get = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await doFetch(`${base}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
    if (!res.ok) throw new ApiError(res.status, `${init.method ?? "GET"} ${path} failed: ${res.status}`);
    return res;
  };

  return {
    async health() {
      return (await (await get("/healthz")).json()) as { status: string; version: string };
    },
    async login(username, password) {
      const res = await doFetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 401 || res.status === 429) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error: string };
        return { ok: false, reason: res.status === 429 ? "locked" : "invalid", message: error };
      }
      if (!res.ok) throw new ApiError(res.status, `POST /api/v1/auth/login failed: ${res.status}`);
      const body = (await res.json()) as { token: string; user: SessionUser };
      return { ok: true, token: body.token, user: body.user };
    },
    async logout() {
      await get("/api/v1/auth/logout", { method: "POST" });
    },
    async checkToken() {
      try {
        await get("/api/v1/session");
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return false;
        throw err;
      }
    },
    async runs(projectId) {
      const body = (await (await get(`/api/v1/projects/${encodeURIComponent(projectId)}/runs`)).json()) as {
        runs: RunView[];
      };
      return body.runs;
    },
    events(projectId, signal) {
      return get(`/api/v1/projects/${encodeURIComponent(projectId)}/events`, {
        headers: { accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
    },
  };
}
