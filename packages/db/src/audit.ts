/**
 * The audit log: who did what, when, from where.
 *
 * Events are only ever added; they leave by age (`purgeAudit`). A detail
 * names things — fields, keys, components — and never carries a value that
 * could be a credential: `recordAudit` refuses keys that look like one, so a
 * caller cannot put a password or secret in by mistake.
 */
import type { Sql } from "postgres";

export type AuditActorKind = "user" | "token" | "system" | "anonymous";

export interface AuditActor {
  kind: AuditActorKind;
  /** The user behind a session or token; null for the system or an anonymous caller. */
  userId: string | null;
  /** Username, a system component (`admin-cli`, `worker`), or the name tried at a failed sign-in. */
  name: string | null;
  /** The API token used, when it was one. */
  tokenId?: string | null;
}

export interface AuditInput {
  actor: AuditActor;
  /** Dotted, lower case: `project.update`, `auth.login.failed`. */
  action: string;
  projectId?: string | null;
  /** What was acted on, by name or id: a username, a token id, a run id. */
  target?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
  forwardedFor?: string | null;
  userAgent?: string | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: { kind: AuditActorKind; userId: string | null; name: string | null; tokenId: string | null };
  action: string;
  projectId: string | null;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  forwardedFor: string | null;
  userAgent: string | null;
}

export const AUDIT_ACTION = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

// Keys a detail may never have, at any depth: they name a credential's value.
const FORBIDDEN_KEY = /^(password|passwd|secret|token|value|values|private.?key|credential)s?$/i;

export class AuditError extends Error {}

function checkDetail(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      checkDetail(v, `${path}[${i}]`);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key))
      throw new AuditError(`audit detail must not carry "${path}${key}": name things, never their values`);
    checkDetail(v, `${path}${key}.`);
  }
}

const clip = (s: string | null | undefined, max: number) => (s ? s.slice(0, max) : null);

export async function recordAudit(sql: Sql, input: AuditInput): Promise<void> {
  if (!AUDIT_ACTION.test(input.action)) throw new AuditError(`"${input.action}" is not an audit action name`);
  const detail = input.detail ?? {};
  checkDetail(detail, "");
  await sql`
    INSERT INTO audit_events (actor_kind, actor_user_id, actor_name, actor_token_id, action, project_id,
                              target, detail, ip, forwarded_for, user_agent)
    VALUES (${input.actor.kind}, ${input.actor.userId}, ${clip(input.actor.name, 200)}, ${input.actor.tokenId ?? null},
            ${input.action}, ${input.projectId ?? null}, ${clip(input.target, 500)}, ${sql.json(detail as never)},
            ${clip(input.ip, 100)}, ${clip(input.forwardedFor, 200)}, ${clip(input.userAgent, 500)})`;
}

export interface AuditQuery {
  /** Exact actor name. */
  actor?: string;
  /** An action, or a dotted prefix of it: `project` matches `project.update` and `project.member.set`. */
  action?: string;
  projectId?: string;
  /** ISO times, inclusive since and exclusive until. */
  since?: string;
  until?: string;
  /** Cursor: only events older than this id (the `next` of the previous page). */
  before?: string;
  /** 1 to 200; 50 by default. */
  limit?: number;
}

export const MAX_AUDIT_PAGE = 200;

interface Row {
  id: string;
  at: Date;
  actor_kind: AuditActorKind;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_token_id: string | null;
  action: string;
  project_id: string | null;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  forwarded_for: string | null;
  user_agent: string | null;
}

/** Newest first. `next` is the cursor for the following page, or null on the last. */
export async function listAudit(sql: Sql, q: AuditQuery = {}): Promise<{ events: AuditEvent[]; next: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), MAX_AUDIT_PAGE);
  const none = sql``;
  const rows = await sql<Row[]>`
    SELECT id::text, at, actor_kind, actor_user_id, actor_name, actor_token_id, action, project_id, target,
           detail, ip, forwarded_for, user_agent
    FROM audit_events
    WHERE true
      ${q.actor !== undefined ? sql`AND actor_name = ${q.actor}` : none}
      ${q.action !== undefined ? sql`AND (action = ${q.action} OR starts_with(action, ${`${q.action}.`}))` : none}
      ${q.projectId !== undefined ? sql`AND project_id = ${q.projectId}` : none}
      ${q.since !== undefined ? sql`AND at >= ${q.since}::timestamptz` : none}
      ${q.until !== undefined ? sql`AND at < ${q.until}::timestamptz` : none}
      ${q.before !== undefined ? sql`AND id < ${q.before}::bigint` : none}
    ORDER BY audit_events.id DESC
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  return {
    events: page.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: { kind: r.actor_kind, userId: r.actor_user_id, name: r.actor_name, tokenId: r.actor_token_id },
      action: r.action,
      projectId: r.project_id,
      target: r.target,
      detail: r.detail,
      ip: r.ip,
      forwardedFor: r.forwarded_for,
      userAgent: r.user_agent,
    })),
    next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Removes events older than `retentionDays`; 0 keeps them all. Returns how many went. */
export async function purgeAudit(sql: Sql, retentionDays: number): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 0)
    throw new AuditError("retentionDays must be a whole number >= 0");
  if (retentionDays === 0) return 0;
  const [row] = await sql<{ n: number }[]>`
    WITH gone AS (DELETE FROM audit_events WHERE at < now() - make_interval(days => ${retentionDays}) RETURNING 1)
    SELECT count(*)::int AS n FROM gone`;
  return row?.n ?? 0;
}
