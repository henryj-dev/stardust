import { ApiError } from "./errors.ts";
import { type RegionOptions, regionFetch } from "./regions.ts";
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
  /**
   * Passed on to the server for its audit log, when the client acts for
   * someone else (the dashboard for a browser). The server does not verify them.
   */
  readonly forward?: { readonly forwardedFor?: string; readonly userAgent?: string };
  /**
   * Several regions' stardust as one: each project's requests go to the region
   * that owns it, shared ones to `home` (or the next that answers).
   */
  readonly regions?: RegionOptions;
}

/**
 * Whether stardust can read a repository: `public` (anyone can), `app` (the
 * GitHub App is installed on it), `token` (the configured token reads it) or
 * `none`. With the App, `installation` says whether it covers all of the
 * owner's repositories or only the ones chosen.
 */
export interface RepoAccess {
  repo: string;
  readable: "public" | "app" | "token" | "none";
  installation?: "all" | "selected";
}

/** One entry of the audit log: who did what. Details name things, never secret values. */
export interface AuditEventView {
  id: string;
  at: string;
  actor: {
    kind: "user" | "token" | "system" | "anonymous";
    userId: string | null;
    name: string | null;
    tokenId: string | null;
  };
  action: string;
  projectId: string | null;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  forwardedFor: string | null;
  userAgent: string | null;
}

export interface AuditFilter {
  actor?: string;
  /** An action or a dotted prefix of one (`project` matches `project.update`). */
  action?: string;
  /** Administrators' list only. */
  project?: string;
  since?: string;
  until?: string;
  /** The `next` cursor of the previous page. */
  before?: string;
  limit?: number;
}

/** One env layer: `_shared` (every component) or a component's own. */
export interface EnvLayerView {
  layer: string;
  /** Send back as `expectedRevision` when changing this layer. */
  revision: string;
  plain: Record<string, string>;
  /** Names only: secret values are never sent back. */
  secrets: string[];
}

export interface EnvView {
  layers: EnvLayerView[];
  /** Whether the caller may change the env (a maintainer or an administrator). */
  canEdit: boolean;
}

export interface EnvChangeInput {
  expectedRevision: string;
  set?: Record<string, string>;
  /** Names in `set` that look like secrets but hold public values. Without it the server refuses them. */
  plainOnPurpose?: string[];
  unset?: string[];
  setSecrets?: Record<string, string>;
  unsetSecrets?: string[];
}

export interface EnvChangeResult {
  status: "committed" | "no_change";
  commit: string | null;
  revision: string;
  /** Per component the change reached: the env revision, and the workloads stamped to roll out (empty when none uses the env). */
  components: Array<{ name: string; envRevision: string; consumers: string[] }>;
}

export interface AuditPage {
  events: AuditEventView[];
  /** Pass as `before` for the next page; null on the last. */
  next: string | null;
}

export interface JobView {
  name: string;
  status: string;
  attempt: number;
  /** When the current attempt started and finished; null until it has. */
  startedAt: string | null;
  finishedAt: string | null;
  /** What the job recorded: `reason` when it failed, `digest`, `buildJob`, `deployCommit`. */
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
  /** Who asked for the run; null for runs from before webhooks were removed. */
  requestedBy: string | null;
  jobs: JobView[];
}

/** How a component is built (W, C, N, or M for a mirrored image) and where its manifests live in the deploy repository. */
export interface ProjectComponent {
  name: string;
  pipeline: "W" | "C" | "N" | "M";
  /** Directory inside the source repository used as the build context. */
  context?: string;
  /** Not for pipeline N, which builds without a Dockerfile of its own. */
  dockerfile?: string;
  /** Pipeline N only: the port the app listens on. */
  port?: number;
  /** Pipelines N and W: environment during the build. Not for secrets. */
  buildEnv?: Record<string, string>;
  /** Pipeline M: the published image to mirror, pinned by digest. */
  image?: string;
  deployDir: string;
}

export interface ProjectView {
  id: string;
  name: string;
  githubRepo: string | null;
  pipelineDef: unknown;
  components: ProjectComponent[];
  metadata: Record<string, unknown>;
}

/**
 * The whole project as `putProject` stores it. The server replaces every
 * field: one left out is reset (`pipelineDef` to null, `metadata` to `{}`),
 * so an edit sends back what it does not change.
 */
export type ProjectInput = Omit<ProjectView, "id">;

/** A run without its jobs. */
export type RunSummary = Omit<RunView, "jobs">;

/** A project as the list returns it: with its newest run, or null when it has none. */
export interface ProjectListItem extends ProjectView {
  lastRun: RunSummary | null;
}

/** What to pull: the default branch when empty, or one branch, tag or commit. */
export type PullTarget = { branch: string } | { tag: string } | { sha: string } | Record<string, never>;

export { ApiError } from "./errors.ts";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  /** The password was right; send a TOTP or recovery code with `loginCode(challenge, code)`. */
  | { ok: false; reason: "second-factor"; challenge: string; message: string }
  | { ok: false; reason: "invalid" | "locked" | "off"; message: string };

export interface TotpState {
  policy: "off" | "optional" | "required";
  enrolled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
}

/** The enabled plugins, by name, and what each adds (e.g. `runtime.restart`). */
export interface Capabilities {
  plugins: Array<{ name: string; capabilities: string[] }>;
}

/** One delivery of a component: the commit built, the image it pushed, the deploy commit. */
export interface Delivery {
  jobId: string;
  runId: string;
  sha: string;
  digest: string;
  deployCommit: string | null;
  finishedAt: string;
}

export interface RollbackResult {
  /** `up-to-date` when the deploy repository already pointed there. */
  status: "committed" | "up-to-date";
  deployCommit: string | null;
  sha: string;
  digest: string;
  job: string;
}

export interface PluginClient {
  get<T>(path: string): Promise<T>;
  /** The raw response of a GET, whatever its status, so a caller can relay a stream such as a log. */
  raw(path: string, signal?: AbortSignal): Promise<Response>;
  send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}

export interface UserView {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  hasPassword: boolean;
  oidc: { issuer: string; subject: string } | null;
  roles: Array<{ projectId: string; role: "maintainer" | "viewer" }>;
}

export interface SessionInfo {
  id: string;
  via: "password" | "oidc";
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

/** One of the caller's API tokens; the secret itself is shown only by `createToken`. */
export interface ApiTokenView {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface Client {
  health(): Promise<{ status: string; version: string }>;
  /** Signs in with a username and password. Wrong credentials and lockout are results, not errors. */
  login(username: string, password: string): Promise<LoginResult>;
  /** The second step of a sign-in: the challenge from `login` and a TOTP or recovery code. */
  loginCode(challenge: string, code: string): Promise<LoginResult>;
  /** One's own two-step sign-in. */
  totp(): Promise<TotpState>;
  /** A new secret for the authenticator app (shown only here); confirm it with a first code. */
  totpSetup(): Promise<{ secret: string; uri: string }>;
  /** Confirms the setup; returns ten recovery codes, shown only here. */
  totpConfirm(code: string): Promise<string[]>;
  /** New recovery codes (the old ones stop working), after a current code. */
  totpRecoveryCodes(code: string): Promise<string[]>;
  /** Turns two-step sign-in off, after a current or recovery code. */
  totpOff(code: string): Promise<void>;
  /**
   * Proves the sign-in again before an action that cannot be undone: a code
   * with TOTP, the password without. ApiError 409 for a single sign-on session.
   */
  reauth(proof: { code?: string; password?: string }): Promise<void>;
  /** Turns someone's TOTP off after a lost phone (administrators). */
  resetTotp(username: string): Promise<void>;
  /** Ends the session of the client's token. */
  /** Ends the session; for a single sign-on session, where to send the browser to sign out at the provider too. */
  logout(): Promise<{ redirect?: string }>;
  /** Which ways of signing in the server offers. */
  authMethods(): Promise<{ password: boolean; oidc: { displayName: string } | null }>;
  /** Starts an OpenID sign-in: where to send the browser, and the state to keep for the callback. */
  /** With `reauth`, the provider is asked to sign the person in again (confirming it is them). */
  oidcStart(options?: { reauth?: boolean }): Promise<{ url: string; state: string }>;
  /** Finishes it with the callback's query string and the state kept since the start. */
  oidcCallback(query: string, state: string): Promise<LoginResult>;
  /** True when the token is accepted. */
  checkToken(): Promise<boolean>;
  /** Who the token belongs to, or null when it is not accepted (401). */
  session(): Promise<SessionUser | null>;
  /** The enabled plugins and what each adds, so a dashboard shows only what this server has. */
  capabilities(): Promise<Capabilities>;
  /** Whether stardust can read a repository (`owner/name`), and how. Administrators only. */
  sourceAccess(repo: string): Promise<RepoAccess>;
  /**
   * A plugin's own API, under /api/v1/plugins/<name>. An ApiError carries the
   * server's reason; 404 also means the plugin is not enabled.
   */
  plugin(name: string): PluginClient;
  runs(projectId: string): Promise<RunView[]>;
  /** One run with its jobs; an ApiError with status 404 when the project or the run is unknown. */
  run(projectId: string, runId: string): Promise<RunView>;
  /**
   * A job's build log as the raw response, whatever its status, so a caller
   * can relay it: 200 plain text (kept open with `follow` while the build
   * prints), 409 not started yet, 410 cleaned up, 404 unknown or logs off.
   */
  buildLog(
    projectId: string,
    runId: string,
    job: string,
    options?: { follow?: boolean; signal?: AbortSignal },
  ): Promise<Response>;
  /**
   * Starts a manual run: builds and delivers the commit the target resolves to.
   * An ApiError carries the server's reason (400 bad target, 422 no such ref, 403/404 no access).
   */
  pull(projectId: string, target?: PullTarget): Promise<{ runId: string; ref: string; sha: string }>;
  /** Deletes a project; `withdraw` also removes its manifests from the deploy repository. Administrators. */
  deleteProject(id: string, options?: { withdraw?: boolean }): Promise<{ ok: true; deployCommit: string | null }>;
  /**
   * Writes starter manifests into a component's empty deploy directory.
   * ApiError 409 when the directory is not empty. Administrators.
   */
  scaffold(
    projectId: string,
    component: string,
    input: { namespace: string; port?: number },
  ): Promise<{ deployCommit: string | null; files: string[] }>;
  /** Cancels a job that has not finished. ApiError 409 when it already has. */
  cancelJob(projectId: string, runId: string, job: string): Promise<void>;
  /** What was delivered for a component, newest first. */
  deliveries(projectId: string, component: string): Promise<Delivery[]>;
  /**
   * Points a component back at an earlier delivery: the one before the latest,
   * or the one `job` names. ApiError 409 when there is nothing to go back to.
   */
  rollback(projectId: string, component: string, job?: string): Promise<RollbackResult>;
  /** Projects the caller may read. */
  projects(): Promise<ProjectListItem[]>;
  /** One project; an ApiError with status 404 when it does not exist or cannot be read. */
  project(id: string): Promise<ProjectView>;
  /**
   * Creates or replaces a project (administrators only). An ApiError carries
   * the server's reason: 400 with what is invalid, 403 for anyone else.
   */
  putProject(id: string, project: ProjectInput): Promise<ProjectView>;
  /** The raw server-sent event stream of a project's runs. */
  events(projectId: string, signal?: AbortSignal): Promise<Response>;
  /** A project's env layers; an ApiError 404 says when editing env is not enabled on the server. */
  env(projectId: string): Promise<EnvView>;
  /**
   * Changes one layer in one commit. An ApiError carries the reason: 400 bad
   * input, 409 the layer changed since it was read, 403/404 no access.
   */
  changeEnv(projectId: string, layer: string, change: EnvChangeInput): Promise<EnvChangeResult>;
  /** The whole audit log, newest first (administrators). An ApiError carries the reason for a bad filter. */
  audit(filter?: AuditFilter): Promise<AuditPage>;
  /** One audit event (administrators); ApiError 404 when unknown. */
  auditEvent(id: string): Promise<AuditEventView>;
  /** Every account, with roles (administrators). */
  users(): Promise<UserView[]>;
  /** Creates an account; without a password, invite it with a link. Administrators. */
  createUser(input: { username: string; displayName?: string; isAdmin?: boolean; password?: string }): Promise<void>;
  /** Changes an account (administrators). ApiError 409 when it would leave no administrator. */
  updateUser(username: string, change: { isAdmin?: boolean; disabled?: boolean; displayName?: string }): Promise<void>;
  /** A one-time link for someone to set their password. The token is shown only here. Administrators. */
  issueLink(username: string, purpose: "invite" | "reset"): Promise<{ token: string; path: string; expiresAt: string }>;
  /** Ends every session and API token of an account (administrators). */
  endAllSessions(username: string): Promise<{ sessions: number; tokens: number }>;
  /** Sets a password through a one-time link; needs no sign-in. */
  useLink(token: string, password: string): Promise<{ username: string }>;
  /** Changes one's own password; other sessions and API tokens end. */
  changePassword(current: string, password: string): Promise<void>;
  /** One's own sessions; `current` is the one asking. */
  sessions(): Promise<SessionInfo[]>;
  endSession(id: string): Promise<void>;
  /** One's own API tokens, oldest first, without their secrets. */
  listTokens(): Promise<ApiTokenView[]>;
  /**
   * Makes an API token that acts with one's roles, ending after `expiresInDays`
   * (null: never). The secret is in the result only; it is not shown again.
   * Needs a fresh sign-in (ApiError 401 asking to confirm it is you).
   */
  createToken(name: string, expiresInDays: number | null): Promise<{ id: string; token: string }>;
  /** Revokes one of one's own tokens; ApiError 404 for an unknown one. */
  revokeToken(id: string): Promise<void>;
  /** One project's audit log (its maintainers and administrators). */
  projectAudit(projectId: string, filter?: Omit<AuditFilter, "project">): Promise<AuditPage>;
}

export function createClient(options: ClientOptions): Client {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.regions
    ? regionFetch(options.fetch ?? fetch, base, options.regions)
    : (options.fetch ?? fetch);
  const headers = (): Record<string, string> => ({
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.forward?.forwardedFor ? { "x-forwarded-for": options.forward.forwardedFor } : {}),
    ...(options.forward?.userAgent ? { "user-agent": options.forward.userAgent } : {}),
  });
  /** GET that turns a refusal into an ApiError with the server's reason. */
  const read = async <T>(path: string): Promise<T> => {
    const res = await doFetch(`${base}${path}`, { headers: headers() });
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
      throw new ApiError(res.status, error || `GET ${path} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  };
  const queryOf = (filter: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== "") q.set(k, String(v));
    const text = q.toString();
    return text ? `?${text}` : "";
  };
  const get = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await doFetch(`${base}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
    if (!res.ok) throw new ApiError(res.status, `${init.method ?? "GET"} ${path} failed: ${res.status}`);
    return res;
  };
  /** A POST with a JSON body; an ApiError carries the server's reason. */
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
      throw new ApiError(res.status, error || `POST ${path} failed: ${res.status}`);
    }
    return res.json();
  };
  const session = async (): Promise<SessionUser | null> => {
    try {
      return ((await (await get("/api/v1/session")).json()) as { user: SessionUser }).user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
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
      if (res.status === 401 || res.status === 429 || res.status === 403) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error: string };
        return {
          ok: false,
          reason: res.status === 429 ? "locked" : res.status === 403 ? "off" : "invalid",
          message: error,
        };
      }
      if (!res.ok) throw new ApiError(res.status, `POST /api/v1/auth/login failed: ${res.status}`);
      const body = (await res.json()) as { token?: string; user?: SessionUser; challenge?: string };
      if (body.challenge)
        return { ok: false, reason: "second-factor", challenge: body.challenge, message: "enter a code" };
      return { ok: true, token: body.token as string, user: body.user as SessionUser };
    },
    async loginCode(challenge, code) {
      const res = await doFetch(`${base}/api/v1/auth/login/totp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge, code }),
      });
      if (res.status === 401) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error: string };
        return { ok: false, reason: "invalid", message: error };
      }
      if (!res.ok) throw new ApiError(res.status, `POST /api/v1/auth/login/totp failed: ${res.status}`);
      const body = (await res.json()) as { token: string; user: SessionUser };
      return { ok: true, token: body.token, user: body.user };
    },
    async totp() {
      return (await (await get("/api/v1/account/totp")).json()) as TotpState;
    },
    async totpSetup() {
      return (await post("/api/v1/account/totp/setup", {})) as { secret: string; uri: string };
    },
    async totpConfirm(code) {
      return ((await post("/api/v1/account/totp/confirm", { code })) as { recoveryCodes: string[] }).recoveryCodes;
    },
    async totpRecoveryCodes(code) {
      return ((await post("/api/v1/account/totp/recovery-codes", { code })) as { recoveryCodes: string[] })
        .recoveryCodes;
    },
    async totpOff(code) {
      const res = await doFetch(`${base}/api/v1/account/totp`, {
        method: "DELETE",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new ApiError(res.status, error || `DELETE /api/v1/account/totp failed: ${res.status}`);
      }
    },
    async reauth(proof) {
      await post("/api/v1/account/reauth", proof);
    },
    async resetTotp(username) {
      await get(`/api/v1/users/${encodeURIComponent(username)}/totp`, { method: "DELETE" });
    },
    plugin(name) {
      const root = `/api/v1/plugins/${encodeURIComponent(name)}`;
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await doFetch(`${base}${root}${path}`, {
          method,
          headers: { ...headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!res.ok) {
          const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
          throw new ApiError(res.status, error || `${method} ${root}${path} failed: ${res.status}`);
        }
        return res.status === 204 ? undefined : res.json();
      };
      return {
        get: async <T>(path: string) => (await call("GET", path)) as T,
        raw: (path: string, signal?: AbortSignal) =>
          doFetch(`${base}${root}${path}`, { headers: headers(), ...(signal ? { signal } : {}) }),
        send: async <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) =>
          (await call(method, path, body)) as T,
      };
    },
    async capabilities() {
      return (await (await get("/api/v1/capabilities")).json()) as Capabilities;
    },
    async sourceAccess(repo) {
      const path = `/api/v1/source/access?repo=${encodeURIComponent(repo)}`;
      const res = await doFetch(`${base}${path}`, { headers: headers() });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new ApiError(res.status, error || `GET ${path} failed: ${res.status}`);
      }
      return (await res.json()) as RepoAccess;
    },
    async authMethods() {
      return (await (await get("/api/v1/auth/methods")).json()) as {
        password: boolean;
        oidc: { displayName: string } | null;
      };
    },
    async oidcStart(options = {}) {
      return (await post("/api/v1/auth/oidc/start", { reauth: options.reauth === true })) as {
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
      const body = (await (await get("/api/v1/auth/logout", { method: "POST" })).json().catch(() => ({}))) as {
        redirect?: string;
      };
      return body.redirect ? { redirect: body.redirect } : {};
    },
    async checkToken() {
      return (await session()) !== null;
    },
    session,
    async projects() {
      return ((await (await get("/api/v1/projects")).json()) as { projects: ProjectListItem[] }).projects;
    },
    async project(id) {
      return (await (await get(`/api/v1/projects/${encodeURIComponent(id)}`)).json()) as ProjectView;
    },
    async putProject(id, project) {
      const path = `/api/v1/projects/${encodeURIComponent(id)}`;
      const res = await doFetch(`${base}${path}`, {
        method: "PUT",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify(project),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new ApiError(res.status, error || `PUT ${path} failed: ${res.status}`);
      }
      return (await res.json()) as ProjectView;
    },
    async runs(projectId) {
      const body = (await (await get(`/api/v1/projects/${encodeURIComponent(projectId)}/runs`)).json()) as {
        runs: RunView[];
      };
      return body.runs;
    },
    async run(projectId, runId) {
      return (await (
        await get(`/api/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`)
      ).json()) as RunView;
    },
    buildLog(projectId, runId, job, options = {}) {
      const path = `/api/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(job)}/log${options.follow ? "?follow=true" : ""}`;
      return doFetch(`${base}${path}`, {
        headers: headers(),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
    async pull(projectId, target = {}) {
      return (await post(`/api/v1/projects/${encodeURIComponent(projectId)}/runs`, target)) as {
        runId: string;
        ref: string;
        sha: string;
      };
    },
    async deleteProject(id, options = {}) {
      const path = `/api/v1/projects/${encodeURIComponent(id)}`;
      const res = await doFetch(`${base}${path}`, {
        method: "DELETE",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ confirm: id, withdraw: options.withdraw === true }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new ApiError(res.status, error || `DELETE ${path} failed: ${res.status}`);
      }
      return (await res.json()) as { ok: true; deployCommit: string | null };
    },
    async scaffold(projectId, component, input) {
      const p = (s: string) => encodeURIComponent(s);
      return (await post(`/api/v1/projects/${p(projectId)}/components/${p(component)}/scaffold`, input)) as {
        deployCommit: string | null;
        files: string[];
      };
    },
    async cancelJob(projectId, runId, job) {
      const p = (s: string) => encodeURIComponent(s);
      await post(`/api/v1/projects/${p(projectId)}/runs/${p(runId)}/jobs/${p(job)}/cancel`, {});
    },
    async deliveries(projectId, component) {
      const p = (s: string) => encodeURIComponent(s);
      const res = await get(`/api/v1/projects/${p(projectId)}/components/${p(component)}/deliveries`);
      return ((await res.json()) as { deliveries: Delivery[] }).deliveries;
    },
    async rollback(projectId, component, job) {
      const p = (s: string) => encodeURIComponent(s);
      return (await post(
        `/api/v1/projects/${p(projectId)}/components/${p(component)}/rollback`,
        job ? { job } : {},
      )) as RollbackResult;
    },
    events(projectId, signal) {
      return get(`/api/v1/projects/${encodeURIComponent(projectId)}/events`, {
        headers: { accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
    },
    env(projectId) {
      return read<EnvView>(`/api/v1/projects/${encodeURIComponent(projectId)}/env`);
    },
    async changeEnv(projectId, layer, change) {
      const path = `/api/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(layer)}`;
      const res = await doFetch(`${base}${path}`, {
        method: "PATCH",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new ApiError(res.status, error || `PATCH ${path} failed: ${res.status}`);
      }
      return (await res.json()) as EnvChangeResult;
    },
    async auditEvent(id) {
      return (await (await get(`/api/v1/audit/${encodeURIComponent(id)}`)).json()) as AuditEventView;
    },
    async users() {
      return ((await (await get("/api/v1/users")).json()) as { users: UserView[] }).users;
    },
    async createUser(input) {
      await post("/api/v1/users", input);
    },
    async updateUser(username, change) {
      const path = `/api/v1/users/${encodeURIComponent(username)}`;
      const res = await doFetch(`${base}${path}`, {
        method: "PATCH",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new ApiError(res.status, error || `PATCH ${path} failed: ${res.status}`);
      }
    },
    async issueLink(username, purpose) {
      return (await post(`/api/v1/users/${encodeURIComponent(username)}/links`, { purpose })) as {
        token: string;
        path: string;
        expiresAt: string;
      };
    },
    async endAllSessions(username) {
      return (await post(`/api/v1/users/${encodeURIComponent(username)}/sessions/end`, {})) as {
        sessions: number;
        tokens: number;
      };
    },
    async useLink(token, password) {
      return (await post("/api/v1/auth/link", { token, password })) as { username: string };
    },
    async changePassword(current, password) {
      await post("/api/v1/account/password", { current, password });
    },
    async sessions() {
      return ((await (await get("/api/v1/account/sessions")).json()) as { sessions: SessionInfo[] }).sessions;
    },
    async endSession(id) {
      await get(`/api/v1/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async listTokens() {
      return (await read<{ tokens: ApiTokenView[] }>("/api/v1/tokens")).tokens;
    },
    async createToken(name, expiresInDays) {
      return (await post("/api/v1/tokens", { name, expiresInDays })) as { id: string; token: string };
    },
    async revokeToken(id) {
      const path = `/api/v1/tokens/${encodeURIComponent(id)}`;
      const res = await doFetch(`${base}${path}`, { method: "DELETE", headers: headers() });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new ApiError(res.status, error || `DELETE ${path} failed: ${res.status}`);
      }
    },
    audit(filter = {}) {
      return read<AuditPage>(`/api/v1/audit${queryOf({ ...filter })}`);
    },
    projectAudit(projectId, filter = {}) {
      return read<AuditPage>(`/api/v1/projects/${encodeURIComponent(projectId)}/audit${queryOf({ ...filter })}`);
    },
  };
}
