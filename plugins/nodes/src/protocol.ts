/**
 * The node agent's wire protocol (version 1), as the agent writes it: JSON
 * text frames over a WebSocket. The agent says `hello` once (its version and
 * host profile), `beat` every five seconds, and `metrics` every minute. The
 * golden frames in agent/testdata/frames are what the agent produces; the
 * parser is tested against them.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 4096;
export const BEAT_INTERVAL_MS = 5_000;

export interface BeatMessage {
  type: "beat";
  seq: number;
  uptimeS: number | null;
  bootId: string | null;
}

export interface HelloMessage {
  type: "hello";
  agentVersion: string | null;
  protocolVersion: number | null;
  hostProfile: Record<string, unknown>;
}

export interface MetricsMessage {
  type: "metrics";
  load: [number, number, number] | null;
  memTotalMb: number | null;
  memAvailMb: number | null;
  disk: Record<string, unknown>;
  systemd: Record<string, unknown>;
  net: Record<string, unknown>;
}

export type ClientMessage = BeatMessage | HelloMessage | MetricsMessage;
export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function parseClientMessage(raw: string): ParseResult {
  if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) return { ok: false, error: "frame too large" };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "not an object" };
  const o = v as Record<string, unknown>;
  switch (o.type) {
    case "beat": {
      const seq = num(o.seq);
      if (seq === null || !Number.isInteger(seq) || seq <= 0)
        return { ok: false, error: "seq must be a positive integer" };
      const uptime = num(o.uptime_s);
      const bootId = typeof o.boot_id === "string" ? o.boot_id : null;
      if (bootId !== null && !UUID.test(bootId)) return { ok: false, error: "boot_id must be a uuid" };
      return { ok: true, msg: { type: "beat", seq, uptimeS: uptime !== null && uptime >= 0 ? uptime : null, bootId } };
    }
    case "hello": {
      const pv = num(o.protocol_version);
      return {
        ok: true,
        msg: {
          type: "hello",
          agentVersion: typeof o.agent_version === "string" ? o.agent_version.slice(0, 64) : null,
          protocolVersion: pv !== null && Number.isInteger(pv) ? pv : null,
          hostProfile: obj(o.host_profile),
        },
      };
    }
    case "metrics": {
      const l = o.load;
      const load =
        Array.isArray(l) && l.length === 3 && l.every((x) => num(x) !== null)
          ? ([l[0], l[1], l[2]] as [number, number, number])
          : null;
      return {
        ok: true,
        msg: {
          type: "metrics",
          load,
          memTotalMb: num(o.mem_total_mb),
          memAvailMb: num(o.mem_avail_mb),
          disk: obj(o.disk),
          systemd: obj(o.systemd),
          net: obj(o.net),
        },
      };
    }
    default:
      return { ok: false, error: `unknown type: ${String(o.type).slice(0, 32)}` };
  }
}

/** What the server says right after the upgrade: the protocol, this session's id, how often to beat. */
export function serverHello(sessionId: string): string {
  return JSON.stringify({
    type: "hello",
    protocol_version: PROTOCOL_VERSION,
    session_id: sessionId,
    beat_interval_ms: BEAT_INTERVAL_MS,
  });
}

export type Liveness = "online" | "degraded" | "missing";

/** Online while beats arrive (15 s, three beats); degraded within the 90 s grace a reconnect needs; missing after. */
export function livenessOf(lastBeatAt: Date | null, now = new Date()): Liveness {
  if (!lastBeatAt) return "missing";
  const age = now.getTime() - lastBeatAt.getTime();
  return age <= 15_000 ? "online" : age <= 90_000 ? "degraded" : "missing";
}
