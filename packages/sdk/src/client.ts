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
  /** Who asked for a manual run; null for runs a webhook started. */
  requestedBy: string | null;
  jobs: JobView[];
}

export interface ProjectView {
  id: string;
  name: string;
  githubRepo: string | null;
  pipelineDef: unknown;
  components: Array<{ name: string; pipeline: string; context?: string; dockerfile?: string; deployDir: string }>;
  metadata: Record<string, unknown>;
  webhookKind: "repo" | "workspace" | "off";
}

/** What to pull: the default branch when empty, or one branch, tag or commit. */
export type PullTarget = { branch: string } | { tag: string } | { sha: string } | Record<string, never>;

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
  /** Which ways of signing in the server offers. */
  authMethods(): Promise<{ password: boolean; oidc: { displayName: string } | null }>;
  /** Starts an OpenID sign-in: where to send the browser, and the state to keep for the callback. */
  oidcStart(): Promise<{ url: string; state: string }>;
  /** Finishes it with the callback's query string and the state kept since the start. */
  oidcCallback(query: string, state: string): Promise<LoginResult>;
  /** True when the token is accepted. */
  checkToken(): Promise<boolean>;
  runs(projectId: string): Promise<RunView[]>;
  /**
   * Starts a manual run: builds and delivers the commit the target resolves to.
   * An ApiError carries the server's reason (400 bad target, 422 no such ref, 403/404 no access).
   */
  pull(projectId: string, target?: PullTarget): Promise<{ runId: string; ref: string; sha: string }>;
  /** Projects the caller may read. */
  projects(): Promise<ProjectView[]>;
  /** One project; an ApiError with status 404 when it does not exist or cannot be read. */
  project(id: string): Promise<ProjectView>;
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
    async authMethods() {
      return (await (await get("/api/v1/auth/methods")).json()) as {
        password: boolean;
        oidc: { displayName: string } | null;
      };
    },
    async oidcStart() {
      return (await (await get("/api/v1/auth/oidc/start", { method: "POST" })).json()) as {
        url: string;
        state: string;
      };
    },
    async oidcCallback(query, state) {
      const res = await doFetch(`${base}/api/v1/auth/oidc/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, state }),
      });
      if (res.status === 401 || res.status === 403) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error: string };
        return { ok: false, reason: "invalid", message: error };
      }
      if (!res.ok) throw new ApiError(res.status, `POST /api/v1/auth/oidc/callback failed: ${res.status}`);
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
    async projects() {
      return ((await (await get("/api/v1/projects")).json()) as { projects: ProjectView[] }).projects;
    },
    async project(id) {
      return (await (await get(`/api/v1/projects/${encodeURIComponent(id)}`)).json()) as ProjectView;
    },
    async runs(projectId) {
      const body = (await (await get(`/api/v1/projects/${encodeURIComponent(projectId)}/runs`)).json()) as {
        runs: RunView[];
      };
      return body.runs;
    },
    async pull(projectId, target = {}) {
      const path = `/api/v1/projects/${encodeURIComponent(projectId)}/runs`;
      const res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new ApiError(res.status, error || `POST ${path} failed: ${res.status}`);
      }
      return (await res.json()) as { runId: string; ref: string; sha: string };
    },
    events(projectId, signal) {
      return get(`/api/v1/projects/${encodeURIComponent(projectId)}/events`, {
        headers: { accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
    },
  };
}
