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

export interface Client {
  health(): Promise<{ status: string; version: string }>;
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
    if (!res.ok) throw new ApiError(res.status, `GET ${path} failed: ${res.status}`);
    return res;
  };

  return {
    async health() {
      return (await (await get("/healthz")).json()) as { status: string; version: string };
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
