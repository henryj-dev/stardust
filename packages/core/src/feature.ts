/**
 * What a feature plugin adds besides ports: API routes, permissions,
 * schedules, database tables and capabilities. Everything here is declared
 * by the plugin and enforced by stardust, so a plugin cannot add an
 * unguarded route, a table outside its own names, or a schedule that runs
 * on every replica.
 */
import { can, type ProjectRole } from "./auth/rbac.ts";
import type { Logger } from "./logger.ts";
import type { Ports } from "./ports/index.ts";

/**
 * Who may use a permission. Administrators may use every permission.
 * `project-readers` (viewers and maintainers) and `project-writers`
 * (maintainers) are per project: the route's `:project` parameter names it,
 * and a project the person cannot read answers 404, as stardust's own do.
 */
export type Grant = "admins" | "signed-in" | "project-readers" | "project-writers";

const GRANTS: readonly Grant[] = ["admins", "signed-in", "project-readers", "project-writers"];

export interface Permission {
  /** `<plugin>:<verb>`, e.g. `runtime:restart`. */
  id: string;
  description: string;
  grantedTo: Grant;
}

/** What a plugin's routes, schedules and job handlers are built with. */
export interface FeatureContext {
  /** The plugin's section of stardust.yaml, already validated. */
  readonly config: Readonly<Record<string, unknown>>;
  /** The region this installation serves (`region` in stardust.yaml). */
  readonly region: string;
  readonly ports: Readonly<Partial<Ports>>;
  readonly log: Logger;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface RouteRequest {
  /** Path parameters, e.g. `id` for `/things/:id`. */
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  /** The JSON body, or null without one. */
  body: unknown;
  user: RouteUser;
  signal: AbortSignal;
}

export interface RouteResponse {
  status: number;
  body?: unknown;
  /**
   * Instead of a JSON body: text sent as it comes, such as a followed log.
   * Always plain text, never sniffed; the request's signal ends it.
   */
  stream?: AsyncIterable<Uint8Array>;
  /**
   * Recorded with the route's audit action when the request changed
   * something (not GET, status below 400). Names only, never values.
   */
  audit?: { target?: string; projectId?: string; detail?: Record<string, unknown> };
}

export interface Route {
  method: Method;
  /** Under `/api/v1/plugins/<plugin>`, starting with `/`. Hono path syntax (`:param`). */
  path: string;
  /** One of the plugin's own permissions. There is no route without one. */
  permission: string;
  /** Audit action for changes, `<plugin>.<what>[.<more>]`. Required for every method but GET. */
  audit?: string;
  /**
   * For what cannot be undone: the caller must have signed in (or confirmed
   * it is them) within the server's re-authentication window.
   */
  fresh?: boolean;
  handle(request: RouteRequest): Promise<RouteResponse>;
}

/** Who a socket's credential says is connecting: a plugin's own principal, not a stardust account. */
export interface SocketPrincipal {
  /** What the plugin knows the peer as, e.g. a host name. */
  id: string;
}

export interface SocketConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketSession {
  message(text: string): Promise<void> | void;
  close(): Promise<void> | void;
}

/**
 * A WebSocket under `/api/v1/plugins/<plugin>`, for peers that are not
 * people (an agent on a host). It does not take a stardust session: the
 * plugin checks the peer's own credential in `authenticate`, and refuses
 * by returning null. Every connection is closed when its session says so.
 */
export interface SocketRoute {
  path: string;
  /** Reads the credential (e.g. a bearer token) from the upgrade request's headers. */
  authenticate(headers: Headers): Promise<SocketPrincipal | null>;
  open(principal: SocketPrincipal, connection: SocketConnection): Promise<SocketSession> | SocketSession;
}

export interface Schedule {
  /** Unique within the plugin; the schedule's full name is `<plugin>.<id>`. */
  id: string;
  /** At most one run per interval across all workers. */
  everyMs: number;
  run(context: FeatureContext & { signal: AbortSignal }): Promise<void>;
}

/**
 * Where a table lives once stardust runs in several regions: `global` tables
 * (accounts, definitions) have one primary every region writes to;
 * `regional` tables (what happened here) live in each region's own database.
 */
export type TableScope = "global" | "regional";

export interface Migration {
  /** `NNNN_<words>.sql`, applied in name order. */
  name: string;
  /** Which database it runs in. One migration, one scope. */
  scope: TableScope;
  sql: string;
}

const PERMISSION_VERB = /^[a-z][a-z0-9-]*$/;
const SCHEDULE_ID = /^[a-z][a-z0-9-]*$/;
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const AUDIT_ACTION = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** The table-name prefix of a plugin: `runtime` → `runtime_`, `dns-cloudflare` → `dns_cloudflare_`. */
export function tablePrefix(plugin: string): string {
  return `${plugin.replaceAll("-", "_")}_`;
}

export function permissionProblems(plugin: string, permissions: readonly Permission[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of permissions) {
    const [owner, verb, ...rest] = p.id.split(":");
    if (owner !== plugin || !verb || rest.length > 0 || !PERMISSION_VERB.test(verb)) {
      problems.push(`permission "${p.id}" must be named ${plugin}:<verb>`);
    }
    if (seen.has(p.id)) problems.push(`permission "${p.id}" is declared twice`);
    seen.add(p.id);
    if (!GRANTS.includes(p.grantedTo)) {
      problems.push(`permission "${p.id}" must be granted to ${GRANTS.join(", ")}`);
    }
  }
  return problems;
}

export function routeProblems(plugin: string, routes: readonly Route[], permissions: readonly Permission[]): string[] {
  const problems: string[] = [];
  const declared = new Map(permissions.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const r of routes) {
    const name = `${r.method} ${r.path}`;
    if (!r.path.startsWith("/") || r.path.includes("..") || /\s/.test(r.path)) {
      problems.push(`route ${name}: the path must start with / and hold no spaces or ..`);
    }
    const permission = declared.get(r.permission);
    if (!permission) problems.push(`route ${name}: permission "${r.permission}" is not declared`);
    else if (permission.grantedTo.startsWith("project-") && !/(^|\/):project(\/|$)/.test(r.path)) {
      problems.push(`route ${name}: a per-project permission needs :project in the path`);
    }
    if (r.method !== "GET") {
      if (!r.audit) problems.push(`route ${name}: a route that changes something needs an audit action`);
      else if (!AUDIT_ACTION.test(r.audit) || !r.audit.startsWith(`${plugin}.`)) {
        problems.push(`route ${name}: audit action "${r.audit}" must be ${plugin}.<what>`);
      }
    }
    if (seen.has(name)) problems.push(`route ${name} is declared twice`);
    seen.add(name);
  }
  return problems;
}

export function scheduleProblems(schedules: readonly Schedule[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of schedules) {
    if (!SCHEDULE_ID.test(s.id)) problems.push(`schedule "${s.id}" must be lower-case words joined by "-"`);
    if (seen.has(s.id)) problems.push(`schedule "${s.id}" is declared twice`);
    seen.add(s.id);
    if (!Number.isInteger(s.everyMs) || s.everyMs < 10_000) {
      problems.push(`schedule "${s.id}" must run at most every 10 seconds (everyMs >= 10000)`);
    }
  }
  return problems;
}

/**
 * A plugin's migrations may only create, alter, drop or write its own
 * tables, so two plugins cannot collide and none can change stardust's
 * (a foreign key to one of stardust's tables is fine). The check reads
 * the statements that name a table; it is a guard against mistakes, not a
 * SQL parser.
 */
export function migrationProblems(plugin: string, migrations: readonly Migration[]): string[] {
  const problems: string[] = [];
  const prefix = tablePrefix(plugin);
  const seen = new Set<string>();
  const TABLE =
    /\b(?:CREATE\s+(?:UNLOGGED\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+\S+\s+ON(?:\s+ONLY)?|INSERT\s+INTO|(?<!\bON\s+)UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+("?)([A-Za-z_][A-Za-z0-9_.]*)\1/gi;
  for (const m of migrations) {
    if (!MIGRATION_NAME.test(m.name)) problems.push(`migration "${m.name}" must be named NNNN_<words>.sql`);
    if (seen.has(m.name)) problems.push(`migration "${m.name}" is declared twice`);
    seen.add(m.name);
    if (m.scope !== "global" && m.scope !== "regional") {
      problems.push(`migration "${m.name}" must say its scope: global or regional`);
    }
    const text = m.sql.replace(/--[^\n]*/g, "");
    for (const match of text.matchAll(TABLE)) {
      const table = (match[2] ?? "").toLowerCase();
      if (!table.startsWith(prefix) || table.includes(".")) {
        problems.push(`migration "${m.name}" names table "${table}"; ${plugin} may only use tables named ${prefix}*`);
      }
    }
  }
  return problems;
}

/**
 * Whether this person may use a permission; for a per-project one, `role` is
 * their role in the route's project. Unknown permissions are denied.
 */
export function mayUse(
  user: Pick<RouteUser, "isAdmin">,
  permission: Permission | undefined,
  role: ProjectRole | null = null,
): boolean {
  if (!permission) return false;
  switch (permission.grantedTo) {
    case "admins":
      return user.isAdmin;
    case "signed-in":
      return true;
    case "project-readers":
      return can(user, "project:read", role);
    case "project-writers":
      return can(user, "project:write", role);
  }
}
