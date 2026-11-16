/**
 * Nodes: hosts that run the node agent. Each agent holds a token for its
 * host and keeps a WebSocket open to stardust; it beats every five seconds
 * and sends metrics every minute. Administrators see every host's state and
 * issue and revoke tokens.
 *
 *   nodes: {}
 *
 * Only each host's latest metrics are kept, for the list: time series
 * belong to a metrics system (Prometheus, Alloy), not here.
 *
 * Agents connect to `<server>/api/v1/plugins/nodes/infra/node-socket` with
 * `Authorization: Bearer stnode_…`: set the agent's url to
 * `<server>/api/v1/plugins/nodes`. Tokens are stored as SHA-256 hex of the
 * whole token, as earlier stardust did, so they can be carried over.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Database, definePlugin, type FeatureContext, type Route, type SocketRoute } from "@stardust/core";
import { livenessOf, parseClientMessage, serverHello } from "./protocol.ts";

export * from "./protocol.ts";

export const NODE_TOKEN_PREFIX = "stnode_";
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const MIGRATION = `
-- Hosts running the node agent, and their tokens (SHA-256 hex of the whole token).
CREATE TABLE nodes_tokens (
  id           text PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  hostname     text NOT NULL,
  label        text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX nodes_tokens_host_idx ON nodes_tokens (hostname) WHERE revoked_at IS NULL;

CREATE TABLE nodes_hosts (
  hostname         text PRIMARY KEY,
  session_id       uuid,
  connected_at     timestamptz,
  last_beat_at     timestamptz,
  last_seq         bigint,
  uptime_s         bigint,
  boot_id          uuid,
  agent_version    text,
  protocol_version int,
  host_profile     jsonb NOT NULL DEFAULT '{}',
  metrics          jsonb,
  metrics_at       timestamptz
);

`;

const database = (ctx: FeatureContext): Database => {
  const db = ctx.ports.database;
  if (!db) throw new Error("nodes needs the database");
  return db;
};

/** Issues a token for a host; earlier live tokens of that host are revoked. Returns the token, shown once. */
export async function issueNodeToken(db: Database, hostname: string, label: string | null, by: string | null) {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!HOSTNAME.test(host)) throw new Error("hostname must be a host name");
  const id = randomBytes(8).toString("hex");
  const token = `${NODE_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  await db.transaction(async (tx) => {
    await tx.query("UPDATE nodes_tokens SET revoked_at = now() WHERE hostname = $1 AND revoked_at IS NULL", [host]);
    await tx.query(
      "INSERT INTO nodes_tokens (id, token_hash, hostname, label, created_by) VALUES ($1, $2, $3, $4, $5)",
      [id, sha256(token), host, label, by],
    );
  });
  return { id, token, hostname: host };
}

function sockets(ctx: FeatureContext): SocketRoute[] {
  const db = database(ctx);
  return [
    {
      path: "/infra/node-socket",
      async authenticate(headers) {
        const token = /^Bearer\s+(\S+)$/.exec(headers.get("authorization") ?? "")?.[1] ?? "";
        if (!token.startsWith(NODE_TOKEN_PREFIX)) return null;
        const [row] = await db.query<{ hostname: string }>(
          `UPDATE nodes_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING hostname`,
          [sha256(token)],
        );
        return row ? { id: row.hostname } : null;
      },
      async open(principal, connection) {
        const host = principal.id;
        const sessionId = randomUUID();
        // One live session per host: a newer one fences the older out.
        await db.query(
          `INSERT INTO nodes_hosts (hostname, session_id, connected_at, last_seq) VALUES ($1, $2, now(), 0)
           ON CONFLICT (hostname) DO UPDATE SET session_id = $2, connected_at = now(), last_seq = 0`,
          [host, sessionId],
        );
        connection.send(serverHello(sessionId));
        let lastSeq = 0;
        const current = async () =>
          ((await db.query<{ session_id: string }>("SELECT session_id FROM nodes_hosts WHERE hostname = $1", [host]))[0]
            ?.session_id ?? null) === sessionId;
        return {
          async message(text) {
            const parsed = parseClientMessage(text);
            if (!parsed.ok) return connection.close(1008, parsed.error);
            const msg = parsed.msg;
            if (msg.type === "beat") {
              if (msg.seq <= lastSeq) return;
              lastSeq = msg.seq;
              const rows = await db.query(
                `UPDATE nodes_hosts SET last_beat_at = now(), last_seq = $3, uptime_s = $4, boot_id = $5
                 WHERE hostname = $1 AND session_id = $2 RETURNING hostname`,
                [host, sessionId, msg.seq, msg.uptimeS, msg.bootId],
              );
              if (rows.length === 0) connection.close(4001, "superseded by a newer session");
              return;
            }
            if (!(await current())) return connection.close(4001, "superseded by a newer session");
            if (msg.type === "hello") {
              await db.query(
                "UPDATE nodes_hosts SET agent_version = $2, protocol_version = $3, host_profile = $4::text::jsonb WHERE hostname = $1",
                [host, msg.agentVersion, msg.protocolVersion, JSON.stringify(msg.hostProfile)],
              );
              return;
            }
            await db.query("UPDATE nodes_hosts SET metrics = $2::text::jsonb, metrics_at = now() WHERE hostname = $1", [
              host,
              JSON.stringify({
                load: msg.load,
                memTotalMb: msg.memTotalMb,
                memAvailMb: msg.memAvailMb,
                disk: msg.disk,
                systemd: msg.systemd,
                net: msg.net,
              }),
            ]);
          },
          close() {},
        };
      },
    },
  ];
}

interface HostRow {
  hostname: string;
  last_beat_at: Date | null;
  connected_at: Date | null;
  uptime_s: string | null;
  agent_version: string | null;
  protocol_version: number | null;
  host_profile: Record<string, unknown>;
  metrics: Record<string, unknown> | null;
  metrics_at: Date | null;
  token_hosts: string | null;
}

function routes(ctx: FeatureContext): Route[] {
  const db = database(ctx);
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return [
    {
      method: "GET",
      path: "/nodes",
      permission: "nodes:read",
      async handle() {
        // Every host with a live token, connected or not, and every host that ever connected.
        const rows = await db.query<HostRow>(`
          SELECT coalesce(h.hostname, t.hostname) AS hostname, h.last_beat_at, h.connected_at, h.uptime_s,
                 h.agent_version, h.protocol_version, coalesce(h.host_profile, '{}') AS host_profile, h.metrics, h.metrics_at,
                 t.hostname AS token_hosts
          FROM nodes_hosts h
          FULL JOIN (SELECT DISTINCT hostname FROM nodes_tokens WHERE revoked_at IS NULL) t ON t.hostname = h.hostname
          ORDER BY 1`);
        const now = new Date();
        return {
          status: 200,
          body: {
            nodes: rows.map((r) => ({
              hostname: r.hostname,
              state: livenessOf(r.last_beat_at ? new Date(r.last_beat_at) : null, now),
              lastBeatAt: iso(r.last_beat_at),
              connectedAt: iso(r.connected_at),
              uptimeS: r.uptime_s === null ? null : Number(r.uptime_s),
              agentVersion: r.agent_version,
              protocolVersion: r.protocol_version,
              hostProfile: r.host_profile,
              metrics: r.metrics,
              metricsAt: iso(r.metrics_at),
              hasToken: r.token_hosts !== null,
            })),
          },
        };
      },
    },
    {
      method: "GET",
      path: "/tokens",
      permission: "nodes:read",
      async handle() {
        const tokens = await db.query(
          `SELECT id, hostname, label, created_by AS "createdBy", created_at AS "createdAt", last_used_at AS "lastUsedAt"
           FROM nodes_tokens WHERE revoked_at IS NULL ORDER BY hostname`,
        );
        return { status: 200, body: { tokens } };
      },
    },
    {
      method: "POST",
      path: "/tokens",
      permission: "nodes:write",
      audit: "nodes.token.issue",
      async handle({ body, user }) {
        const b = (body ?? {}) as { hostname?: unknown; label?: unknown };
        if (typeof b.hostname !== "string") return { status: 400, body: { error: "hostname is required" } };
        try {
          const issued = await issueNodeToken(
            db,
            b.hostname,
            typeof b.label === "string" ? b.label.slice(0, 120) : null,
            user.username,
          );
          // The token is in this answer only, for the host's agent.
          return { status: 201, body: issued, audit: { target: issued.hostname, detail: { tokenId: issued.id } } };
        } catch (err) {
          return { status: 400, body: { error: (err as Error).message } };
        }
      },
    },
    {
      method: "DELETE",
      path: "/tokens/:id",
      permission: "nodes:write",
      audit: "nodes.token.revoke",
      async handle({ params }) {
        const [row] = await db.query<{ hostname: string }>(
          "UPDATE nodes_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING hostname",
          [params.id ?? ""],
        );
        if (!row) return { status: 404, body: { error: "unknown token" } };
        // A revoked host's open session ends at its next beat.
        await db.query("UPDATE nodes_hosts SET session_id = NULL WHERE hostname = $1", [row.hostname]);
        return { status: 200, body: { ok: true }, audit: { target: row.hostname, detail: { tokenId: params.id } } };
      },
    },
  ];
}

export const plugin = definePlugin({
  manifest: { name: "nodes", description: "Hosts running the node agent: liveness, metrics and their tokens." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    return Object.keys(s).map((k) => `unknown key "${k}"`);
  },
  requires: ["database"],
  permissions: [
    { id: "nodes:read", description: "See hosts and their state", grantedTo: "admins" },
    { id: "nodes:write", description: "Issue and revoke agent tokens", grantedTo: "admins" },
  ],
  capabilities: ["nodes.list"],
  migrations: async () => [{ name: "0001_nodes.sql", scope: "regional", sql: MIGRATION }],
  routes,
  sockets,
});
