/**
 * Instances: cloud machines made, resized and deleted from stardust.
 *
 *   instances:
 *     account: vultr                 # optional: the compute account; the only one by default
 *     sshKeys: [ops]                 # key names from the catalog, put on every instance
 *     cloudInit: |                   # optional; {{hostname}} is filled in. Cleared once the instance is up.
 *       #cloud-config
 *     dns:                           # optional: records through the dns port
 *       provider: cloudflare
 *       zone: example.com
 *       internalSuffix: internal.example.com
 *     protected:                     # never deleted, whatever is approved
 *       prefixes: [db-]
 *       exact: [gateway.example.com]
 *
 * Creating is a saga the worker runs and resumes: create, wait until it
 * runs, DNS records, the reverse name, clear the user data. A create that
 * fails after the instance exists leaves it for a person: deleting needs a
 * person's approval, and a saga has none to give.
 *
 * Deleting takes two calls from someone who signed in recently: one names
 * the instance again and returns a short-lived ticket, the other spends it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type ComputeProvider,
  checkApproval,
  createInstanceProblems,
  type Database,
  definePlugin,
  defineSaga,
  type FeatureContext,
  isProtected,
  issueApproval,
  type ProtectedTargets,
  type Route,
  runSaga,
  type SagaRecord,
  startSaga,
} from "@stardust/core";
import { combineUserData, type DnsSettings, plannedRecords, renderCloudInit } from "./naming.ts";

export { combineUserData, type DnsSettings, type PlannedRecord, plannedRecords, renderCloudInit } from "./naming.ts";

const MIGRATION = `
-- Operations on instances: a create is a saga with the same id.
CREATE TABLE instances_ops (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('create', 'resize', 'delete')),
  hostname     text NOT NULL,
  instance_id  text,
  status       text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  detail       jsonb NOT NULL DEFAULT '{}',
  error        text CHECK (length(error) <= 2000),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  -- Who is driving a running create, until when: one worker at a time.
  lease_holder text,
  lease_until  timestamptz
);
CREATE INDEX instances_ops_running_idx ON instances_ops (requested_at) WHERE status = 'running';

-- The key delete tickets are signed with: made here, used only here.
CREATE TABLE instances_keys (
  id    text PRIMARY KEY,
  value text NOT NULL
);
`;

interface Section {
  account?: string;
  sshKeys?: string[];
  cloudInit?: string;
  dns?: DnsSettings;
  protected?: ProtectedTargets;
}

export interface CreateState {
  account: string;
  hostname: string;
  label: string;
  region: string;
  plan: string;
  image: string;
  networks: string[];
  tags: string[];
  instanceId?: string;
  mainIp?: string | null;
  ipv6?: string | null;
  internalIp?: string | null;
  /** Records this saga wrote, so a failure removes exactly those. */
  records: Array<{ zone: string; id: string }>;
  ptr?: string | null;
  /** Whether user data went in, so it is cleared once the instance runs. */
  userDataSet?: boolean;
}

/** The configured hooks, in name order. */
const hooksOf = (ctx: FeatureContext) =>
  Object.entries(ctx.ports.instanceHooks ?? {}).sort(([a], [b]) => a.localeCompare(b));

const TICKET_MS = 5 * 60_000;
const RUNNING_WITHIN_MS = 15 * 60_000;

class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function needs(ctx: FeatureContext) {
  const { database, sagas, guards } = ctx.ports;
  const accounts = ctx.ports.compute ?? {};
  if (!database || !sagas || !guards) throw new Error("instances needs the database, sagas and guards");
  const section = ctx.config as Section;
  const name = section.account ?? Object.keys(accounts)[0] ?? "";
  return { db: database, sagas, guards, section, account: name, compute: accounts[name] };
}

/** The saga, bound to the ports it runs with. `sleep` is replaceable for tests. */
export function createSaga(ctx: FeatureContext, sleep = (ms: number, signal: AbortSignal) => wait(ms, signal)) {
  const { section } = needs(ctx);
  const computeOf = (s: CreateState): ComputeProvider => {
    const c = ctx.ports.compute?.[s.account];
    if (!c) throw new Error(`no compute account "${s.account}"`);
    return c;
  };
  const dnsOf = () => (section.dns ? ctx.ports.dns?.[section.dns.provider] : undefined);
  return defineSaga<CreateState>({
    kind: "instances.create",
    steps: [
      {
        name: "create",
        async run(s) {
          const compute = computeOf(s);
          // A create that went through just before a crash is found, not made again.
          const already = (await compute.list()).find((i) => i.hostname === s.hostname);
          if (already) return { ...s, instanceId: already.id };
          const keys = section.sshKeys?.length ? (await compute.catalog()).sshKeys : [];
          const missing = (section.sshKeys ?? []).filter((n) => !keys.some((k) => k.name === n));
          if (missing.length > 0) throw new Error(`no SSH key named ${missing.join(", ")} in the account`);
          // Hooks prepare inside this step, so what they return (a one-time
          // token, say) is never stored in the saga's state.
          const parts = section.cloudInit ? [renderCloudInit(section.cloudInit, s.hostname)] : [];
          for (const [name, hook] of hooksOf(ctx)) {
            if (!hook.prepare) continue;
            try {
              const added = await hook.prepare({ hostname: s.hostname, region: s.region, networks: s.networks });
              if (added.userData) parts.push(added.userData);
            } catch (err) {
              throw new Error(`hook ${name} refused: ${(err as Error).message}`);
            }
          }
          const userData = combineUserData(parts);
          const made = await compute.create({
            label: s.label,
            hostname: s.hostname,
            region: s.region,
            plan: s.plan,
            image: s.image,
            sshKeys: keys.filter((k) => section.sshKeys?.includes(k.name)).map((k) => k.id),
            ...(userData ? { userData } : {}),
            ...(s.networks.length ? { networks: s.networks } : {}),
            ...(s.tags.length ? { tags: s.tags } : {}),
          });
          return { ...s, instanceId: made.id, userDataSet: Boolean(userData) };
        },
        // Nothing undoes a create: deleting needs a person's approval.
      },
      {
        name: "wait-running",
        async run(s, signal) {
          const deadline = Date.now() + RUNNING_WITHIN_MS;
          for (;;) {
            const now = await computeOf(s).get(s.instanceId ?? "");
            if (now?.state === "running" && now.mainIp && (!s.networks.length || now.internalIp)) {
              return { ...s, mainIp: now.mainIp, ipv6: now.ipv6, internalIp: now.internalIp };
            }
            if (Date.now() > deadline) throw new Error("the instance did not come up within 15 minutes");
            await sleep(10_000, signal);
          }
        },
      },
      {
        name: "dns",
        async run(s) {
          const dns = dnsOf();
          const { records } = plannedRecords(
            s.hostname,
            { mainIp: s.mainIp ?? null, ipv6: s.ipv6 ?? null, internalIp: s.internalIp ?? null },
            section.dns,
          );
          if (!dns || !section.dns || records.length === 0) return s;
          const written: CreateState["records"] = [];
          for (const r of records) {
            const done = await dns.upsert(section.dns.zone, { ...r, ttl: section.dns.ttl ?? 300 });
            written.push({ zone: section.dns.zone, id: done.id });
          }
          return { ...s, records: written };
        },
        async compensate(s) {
          const dns = dnsOf();
          for (const r of s.records) await dns?.delete(r.zone, r.id);
        },
      },
      {
        name: "reverse-dns",
        async run(s) {
          const { ptr } = plannedRecords(
            s.hostname,
            { mainIp: s.mainIp ?? null, ipv6: null, internalIp: null },
            section.dns,
          );
          const compute = computeOf(s);
          if (!ptr || !compute.setReverseDns || !s.mainIp) return { ...s, ptr: null };
          await compute.setReverseDns(s.instanceId ?? "", s.mainIp, ptr);
          return { ...s, ptr };
        },
      },
      {
        name: "hooks",
        async run(s) {
          const instance = await computeOf(s).get(s.instanceId ?? "");
          if (!instance) throw new Error("the instance is gone");
          for (const [name, hook] of hooksOf(ctx)) {
            try {
              await hook.created?.(instance);
            } catch (err) {
              throw new Error(`hook ${name}: ${(err as Error).message}`);
            }
          }
          return s;
        },
      },
      {
        name: "clear-user-data",
        async run(s) {
          // cloud-init can carry bootstrap secrets, from the template or a hook:
          // once the instance runs they must not stay readable.
          if (s.userDataSet) await computeOf(s).clearUserData(s.instanceId ?? "", "created by stardust");
          return s;
        },
      },
    ],
  });
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const LEASE = "90 seconds";

/**
 * Runs (or resumes) every create still running, and records how each ended.
 * Each create is leased to one caller and the lease is renewed while it
 * waits; a caller that loses its lease stops, so no create runs twice.
 */
export async function driveCreates(ctx: FeatureContext, signal: AbortSignal, sleep = wait) {
  const { db, sagas } = needs(ctx);
  const holder = randomUUID();
  const running = await db.query<{ id: string }>(
    "SELECT id FROM instances_ops WHERE kind = 'create' AND status = 'running' ORDER BY requested_at",
  );
  for (const { id } of running) {
    if (signal.aborted) return;
    const claimed = await db.query(
      `UPDATE instances_ops SET lease_holder = $2, lease_until = now() + interval '${LEASE}'
       WHERE id = $1 AND status = 'running' AND (lease_until IS NULL OR lease_until < now() OR lease_holder = $2) RETURNING id`,
      [id, holder],
    );
    if (claimed.length === 0) continue;
    const mine = new AbortController();
    const stop = () => mine.abort();
    signal.addEventListener("abort", stop, { once: true });
    const renewingSleep = async (ms: number, s: AbortSignal) => {
      const kept = await db.query(
        `UPDATE instances_ops SET lease_until = now() + interval '${LEASE}' WHERE id = $1 AND lease_holder = $2 RETURNING id`,
        [id, holder],
      );
      if (kept.length === 0) return mine.abort();
      await sleep(ms, s);
    };
    const r = (await runSaga(sagas, createSaga(ctx, renewingSleep), id, mine.signal)) as SagaRecord<CreateState>;
    signal.removeEventListener("abort", stop);
    if (r.status === "running") continue;
    await db.query(
      `UPDATE instances_ops SET status = $2, instance_id = $3, detail = $4::text::jsonb, error = $5, finished_at = now() WHERE id = $1`,
      [
        id,
        r.status === "succeeded" ? "succeeded" : "failed",
        r.state.instanceId ?? null,
        JSON.stringify({
          mainIp: r.state.mainIp ?? null,
          internalIp: r.state.internalIp ?? null,
          records: r.state.records.length,
          ptr: r.state.ptr ?? null,
          failedStep: r.failedStep,
          sagaStatus: r.status,
        }),
        r.error,
      ],
    );
  }
}

async function approvalKey(db: Database): Promise<string> {
  await db.query("INSERT INTO instances_keys (id, value) VALUES ('delete', $1) ON CONFLICT (id) DO NOTHING", [
    randomBytes(32).toString("hex"),
  ]);
  const [row] = await db.query<{ value: string }>("SELECT value FROM instances_keys WHERE id = 'delete'");
  if (!row) throw new Error("no approval key");
  return row.value;
}

const wrap = async (
  work: () => Promise<{ body: Record<string, unknown>; audit?: { target: string; detail?: Record<string, unknown> } }>,
  status = 200,
) => {
  try {
    const { body, audit } = await work();
    return { status, body, ...(audit ? { audit } : {}) };
  } catch (err) {
    if (err instanceof Refused) return { status: err.status, body: { error: err.message } };
    throw err;
  }
};

function routes(ctx: FeatureContext): Route[] {
  const { db, sagas, guards, section, account, compute } = needs(ctx);
  const obj = (b: unknown) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {});
  const need = (): ComputeProvider => {
    if (!compute) throw new Refused(409, "no compute account is configured");
    return compute;
  };
  const found = async (id: string) => {
    const i = await need().get(id);
    if (!i) throw new Refused(404, "no such instance");
    return i;
  };
  return [
    {
      method: "GET",
      path: "/instances",
      permission: "instances:read",
      handle: () =>
        wrap(async () => {
          const c = need();
          const [instances, ops] = await Promise.all([
            c.list(),
            db.query(
              'SELECT id, kind, hostname, instance_id AS "instanceId", status, detail, error, requested_by AS "requestedBy", requested_at AS "requestedAt", finished_at AS "finishedAt" FROM instances_ops ORDER BY requested_at DESC LIMIT 50',
            ),
          ]);
          return {
            body: {
              account,
              capabilities: c.capabilities,
              instances: instances.map((i) => ({ ...i, protected: isProtected(i.hostname, section.protected ?? {}) })),
              ops,
            },
          };
        }),
    },
    {
      method: "GET",
      path: "/catalog",
      permission: "instances:read",
      handle: () => wrap(async () => ({ body: { ...(await need().catalog()) } })),
    },
    {
      method: "POST",
      path: "/instances",
      permission: "instances:write",
      audit: "instances.create",
      handle: ({ body, user }) =>
        wrap(async () => {
          need();
          const b = obj(body);
          const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
          const list = (k: string) =>
            Array.isArray(b[k]) ? (b[k] as unknown[]).filter((x): x is string => typeof x === "string") : [];
          const hostname = str("hostname").toLowerCase();
          const state: CreateState = {
            account,
            hostname,
            label: str("label") || hostname,
            region: str("region"),
            plan: str("plan"),
            image: str("image"),
            networks: list("networks"),
            tags: list("tags"),
            records: [],
          };
          const problems = createInstanceProblems(state);
          if (problems.length > 0) throw new Refused(400, problems.join("; "));
          const taken = (await need().list()).some((i) => i.hostname === hostname);
          const pending = await db.query(
            "SELECT 1 FROM instances_ops WHERE hostname = $1 AND kind = 'create' AND status = 'running'",
            [hostname],
          );
          if (taken || pending.length > 0) throw new Refused(409, `${hostname} exists or is being made`);
          const id = randomUUID();
          await startSaga(sagas, createSaga(ctx), id, state);
          await db.query(
            "INSERT INTO instances_ops (id, kind, hostname, status, requested_by) VALUES ($1, 'create', $2, 'running', $3)",
            [id, hostname, user.username],
          );
          return {
            body: { op: id, hostname },
            audit: { target: hostname, detail: { op: id, region: state.region, plan: state.plan } },
          };
        }, 202),
    },
    {
      method: "POST",
      path: "/instances/:id/resize",
      permission: "instances:write",
      audit: "instances.resize",
      handle: ({ params, body, user }) =>
        wrap(async () => {
          const c = need();
          if (!c.resize) throw new Refused(409, "this account cannot resize");
          const i = await found(params.id ?? "");
          const plan = String(obj(body).plan ?? "");
          if (!(await c.catalog()).plans.some((p) => p.id === plan))
            throw new Refused(400, "plan must be one of the catalog's");
          await c.resize(i.id, plan);
          await db.query(
            "INSERT INTO instances_ops (id, kind, hostname, instance_id, status, detail, requested_by, finished_at) VALUES ($1, 'resize', $2, $3, 'succeeded', $4::text::jsonb, $5, now())",
            [randomUUID(), i.hostname, i.id, JSON.stringify({ from: i.plan, to: plan }), user.username],
          );
          return { body: { ok: true }, audit: { target: i.hostname, detail: { from: i.plan, to: plan } } };
        }),
    },
    {
      method: "GET",
      path: "/instances/:id/console",
      permission: "instances:write",
      handle: ({ params }) =>
        wrap(async () => {
          const c = need();
          const i = await found(params.id ?? "");
          return { body: { url: c.console ? await c.console(i.id) : null } };
        }),
    },
    {
      method: "POST",
      path: "/instances/:id/delete/approve",
      permission: "instances:write",
      audit: "instances.delete.approve",
      fresh: true,
      handle: ({ params, body }) =>
        wrap(async () => {
          const i = await found(params.id ?? "");
          if (obj(body).confirm !== i.hostname) throw new Refused(400, "repeat the instance's hostname in confirm");
          if (isProtected(i.hostname, section.protected ?? {}))
            throw new Refused(403, `${i.hostname} is protected: it is never deleted`);
          const ticket = issueApproval(await approvalKey(db), { action: "instances.destroy", target: i.id }, TICKET_MS);
          return {
            body: { ticket, expiresInSeconds: TICKET_MS / 1000 },
            audit: { target: i.hostname, detail: { instance: i.id } },
          };
        }),
    },
    {
      method: "POST",
      path: "/instances/:id/delete",
      permission: "instances:write",
      audit: "instances.delete",
      fresh: true,
      handle: ({ params, body, user }) =>
        wrap(async () => {
          const c = need();
          const i = await found(params.id ?? "");
          // Checked again: the list may have changed since the ticket.
          if (isProtected(i.hostname, section.protected ?? {}))
            throw new Refused(403, `${i.hostname} is protected: it is never deleted`);
          const ticket = String(obj(body).ticket ?? "");
          const check = await checkApproval(
            await approvalKey(db),
            ticket,
            { action: "instances.destroy", target: i.id },
            guards,
          );
          if (!check.ok) throw new Refused(403, `the approval is ${check.reason}: approve the deletion again`);
          for (const [name, hook] of hooksOf(ctx)) {
            try {
              await hook.beforeDestroy?.(i);
            } catch (err) {
              throw new Refused(409, `hook ${name} refused the delete: ${(err as Error).message}`);
            }
          }
          await c.destroy(i.id, user.username);
          const hookErrors: string[] = [];
          for (const [name, hook] of hooksOf(ctx)) {
            await hook.destroyed?.(i).catch((err: Error) => hookErrors.push(`${name}: ${err.message}`));
          }
          // Its records go with it: a name pointing at a released address is someone else's later.
          const dns = section.dns ? ctx.ports.dns?.[section.dns.provider] : undefined;
          let removed = 0;
          if (dns && section.dns) {
            const addresses = new Set([i.mainIp, i.ipv6, i.internalIp].filter(Boolean));
            const { records } = plannedRecords(i.hostname, i, section.dns);
            for (const r of records) {
              for (const existing of await dns.listRecords(section.dns.zone, { name: r.name, type: r.type })) {
                if (addresses.has(existing.content)) {
                  await dns.delete(section.dns.zone, existing.id, existing.view ?? undefined);
                  removed++;
                }
              }
            }
          }
          await db.query(
            "INSERT INTO instances_ops (id, kind, hostname, instance_id, status, detail, requested_by, finished_at) VALUES ($1, 'delete', $2, $3, 'succeeded', $4::text::jsonb, $5, now())",
            [randomUUID(), i.hostname, i.id, JSON.stringify({ records: removed, hookErrors }), user.username],
          );
          return {
            body: { ok: true, recordsRemoved: removed, hookErrors },
            audit: { target: i.hostname, detail: { instance: i.id, records: removed, hookErrors } },
          };
        }),
    },
  ];
}

export const plugin = definePlugin({
  manifest: { name: "instances", description: "Cloud instances: create, resize, console and delete." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems = Object.keys(s)
      .filter((k) => !["account", "sshKeys", "cloudInit", "dns", "protected"].includes(k))
      .map((k) => `unknown key "${k}"`);
    if (s.account !== undefined && typeof s.account !== "string")
      problems.push("account must be a compute account name");
    if (s.sshKeys !== undefined && (!Array.isArray(s.sshKeys) || !s.sshKeys.every((k) => typeof k === "string"))) {
      problems.push("sshKeys must be a list of key names");
    }
    if (s.cloudInit !== undefined && (typeof s.cloudInit !== "string" || Buffer.byteLength(s.cloudInit) > 60 * 1024)) {
      problems.push("cloudInit must be text of at most 60 KiB");
    }
    if (s.dns !== undefined) {
      const d = s.dns as Record<string, unknown>;
      if (typeof d.provider !== "string" || typeof d.zone !== "string") problems.push("dns needs provider and zone");
      if (
        d.internalSuffix !== undefined &&
        (typeof d.internalSuffix !== "string" || !String(d.internalSuffix).endsWith(String(d.zone)))
      ) {
        problems.push("dns.internalSuffix must be a name inside dns.zone");
      }
    }
    if (s.protected !== undefined) {
      const p = s.protected as Record<string, unknown>;
      for (const k of ["prefixes", "exact"]) {
        if (p[k] !== undefined && (!Array.isArray(p[k]) || !(p[k] as unknown[]).every((x) => typeof x === "string"))) {
          problems.push(`protected.${k} must be a list of names`);
        }
      }
    }
    return problems;
  },
  requires: ["compute", "database", "sagas", "guards"],
  uses: ["dns", "instanceHooks"],
  permissions: [
    { id: "instances:read", description: "See instances and what was done to them", grantedTo: "admins" },
    {
      id: "instances:write",
      description: "Create, resize, open the console of and delete instances",
      grantedTo: "admins",
    },
  ],
  capabilities: ["instances.list"],
  migrations: async () => [{ name: "0001_instances.sql", scope: "regional", sql: MIGRATION }],
  schedules: [{ id: "creates", everyMs: 15_000, run: (ctx) => driveCreates(ctx, ctx.signal) }],
  routes,
});
