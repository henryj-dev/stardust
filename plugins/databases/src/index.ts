/**
 * Databases: create PostgreSQL instances, adopt ones already running, give
 * an application its own role and database, and back them all up, all as
 * commits to the deploy repository. Stardust never connects to a database:
 * the engine (a `databases` port such as db-statefulset) renders manifests,
 * passwords are generated here and sealed with the cipher, and the pods read
 * them.
 *
 *   databases:
 *     root: deploy/databases      # optional: where the manifests go
 *     backup:                     # optional: a CronJob per namespace with instances
 *       schedule: "15 3 * * *"
 *       storage: { endpoint: https://s3.example.com, bucket: backups, credentials: db-backup-s3, prefix: pg }
 *       recipient: age1…           # dumps are encrypted to this key
 *       retentionHours: 168
 *
 * Point a GitOps Kustomization at `root`. The storage credentials Secret
 * (`access-key-id`, `secret-access-key`) must exist in each namespace that is
 * backed up.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  type BoundRepo,
  backupPlanProblems,
  commitWithCas,
  type Database,
  definePlugin,
  type FeatureContext,
  isKubeName,
  isSqlName,
  listResources,
  type Route,
  type SecretCipher,
} from "@stardust/core";
import { type BackupSettings, type ManagedInstance, planBackups, RootChange, secretDocument } from "./layout.ts";

export { type BackupSettings, type ManagedInstance, planBackups, RootChange } from "./layout.ts";

const CHECKS_MIGRATION = `
-- Restore checks: a Job per check, committed, followed until it finishes, then removed.
CREATE TABLE databases_checks (
  job          text PRIMARY KEY,
  instance     text NOT NULL,
  namespace    text NOT NULL,
  files        jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed')),
  detail       text CHECK (length(detail) <= 500),
  requested_by text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX databases_checks_instance_idx ON databases_checks (instance, requested_at DESC);
`;

const MIGRATION = `
-- Instances stardust manages, created by it or adopted.
CREATE TABLE databases_instances (
  name             text PRIMARY KEY,
  provider         text NOT NULL,
  namespace        text NOT NULL,
  workload         text NOT NULL,
  origin           text NOT NULL CHECK (origin IN ('created', 'adopted')),
  host             text NOT NULL,
  superuser_secret text,
  superuser_key    text,
  version          text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, workload)
);

-- An application's role and database on an instance, and where its env went.
CREATE TABLE databases_grants (
  instance    text NOT NULL REFERENCES databases_instances (name) ON DELETE CASCADE,
  role        text NOT NULL,
  database    text NOT NULL,
  project_id  text NOT NULL,
  layer       text NOT NULL,
  env_prefix  text NOT NULL DEFAULT '',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance, role)
);
`;

interface Section {
  root?: string;
  backup?: BackupSettings;
  /** Where restore checks run, and the age identity they decrypt with. */
  restoreCheck?: { namespace: string; identity: { name: string; key: string } };
  /** Whether instances may be deleted at all. */
  allowDelete?: boolean;
}

/** How long a passed restore check lets an instance be deleted. */
const CHECK_VALID_MS = 24 * 3_600_000;
/** A check whose Job never appeared is given up after this. */
const CHECK_APPEARS_MS = 2 * 3_600_000;

interface InstanceRow {
  name: string;
  provider: string;
  namespace: string;
  workload: string;
  origin: "created" | "adopted";
  host: string;
  superuser_secret: string | null;
  superuser_key: string | null;
  version: string | null;
}

const ENV_KEYS = ["DATABASE_URL", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const;
const managed = (r: InstanceRow): ManagedInstance => ({
  name: r.name,
  provider: r.provider,
  namespace: r.namespace,
  workload: r.workload,
  host: r.host,
  superuser: r.superuser_secret && r.superuser_key ? { name: r.superuser_secret, key: r.superuser_key } : null,
});
const newPassword = () => randomBytes(24).toString("base64url");
const dashed = (role: string) => role.replace(/_/g, "-");
const grantSecretName = (instance: string, role: string) =>
  `${instance}-grant-${dashed(role)}`.slice(0, 63).replace(/-+$/, "");

class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function needs(ctx: FeatureContext) {
  const { database, deployRepo, cipher } = ctx.ports;
  const providers = ctx.ports.databases ?? {};
  if (!database || !deployRepo || !cipher)
    throw new Error("databases needs the database, the deploy repository and the cipher");
  return { db: database, repo: deployRepo.repo, cipher, providers };
}

async function sealed(cipher: SecretCipher, at: BoundRepo, path: string, plain: string): Promise<string> {
  return (await cipher.encryptIfChanged((await at.read(path))?.content ?? null, plain)).document;
}

export function databasesFeature(ctx: FeatureContext) {
  const { db, repo, cipher, providers } = needs(ctx);
  const section = ctx.config as Section;
  const root = (section.root ?? "deploy/databases").replace(/\/+$/, "");
  const all = async (q: Database = db) =>
    (await q.query<InstanceRow>("SELECT * FROM databases_instances ORDER BY name")).map(managed);

  /** One commit: `plan` changes the tree, and backups follow the instances it leaves. */
  async function commit(
    message: string,
    instances: () => Promise<ManagedInstance[]>,
    plan: (c: RootChange, at: BoundRepo) => Promise<void>,
  ) {
    const result = await commitWithCas(repo, async (_head, at) => {
      const change = new RootChange(root, at);
      await plan(change, at);
      await planBackups(change, await instances(), providers, section.backup);
      return { files: change.files, message };
    });
    if (result.status === "error")
      throw new Refused(502, `the deploy repository refused the commit: ${result.message}`);
    return result.status === "committed" ? result.sha : null;
  }

  async function create(body: Record<string, unknown>, by: string) {
    const providerName = typeof body.provider === "string" ? body.provider : Object.keys(providers)[0];
    const provider = providerName ? providers[providerName] : undefined;
    if (!provider || !providerName) throw new Refused(400, "no such database engine");
    const spec = {
      name: String(body.name ?? ""),
      version: String(body.version ?? provider.capabilities.versions.at(-1) ?? ""),
      storage: String(body.storage ?? "10Gi"),
      cpu: String(body.cpu ?? "250m"),
      memory: String(body.memory ?? "512Mi"),
      ...(typeof body.storageClass === "string" && body.storageClass ? { storageClass: body.storageClass } : {}),
    };
    const problems = provider.specProblems(spec);
    if (problems.length > 0) throw new Refused(400, problems.join("; "));
    const ns = provider.capabilities.namespace;
    const superuser = provider.superuserSecret(spec.name);
    const row: ManagedInstance = {
      name: spec.name,
      provider: providerName,
      namespace: ns,
      workload: spec.name,
      host: `${spec.name}.${ns}.svc`,
      superuser,
    };
    return db.transaction(async (tx) => {
      const taken = await tx.query(
        "SELECT 1 FROM databases_instances WHERE name = $1 OR (namespace = $2 AND workload = $1)",
        [spec.name, ns],
      );
      if (taken.length > 0) throw new Refused(409, `${spec.name} exists already`);
      await tx.query(
        `INSERT INTO databases_instances (name, provider, namespace, workload, origin, host, superuser_secret, superuser_key, version, created_by)
         VALUES ($1, $2, $3, $1, 'created', $4, $5, $6, $7, $8)`,
        [spec.name, providerName, ns, row.host, superuser.name, superuser.key, spec.version, by],
      );
      // The row is written in this transaction: if the commit fails, it goes too.
      const sha = await commit(
        `databases: create ${spec.name}`,
        () => all(tx),
        async (change, at) => {
          const dir = change.path(spec.name);
          if ((await at.read(`${dir}/kustomization.yaml`)) !== null)
            throw new Refused(409, `${dir} exists in the deploy repository`);
          const files = provider.renderInstance(spec);
          const secretPath = `${dir}/superuser.secret.enc.yaml`;
          change.write(
            secretPath,
            await sealed(
              cipher,
              at,
              secretPath,
              secretDocument(superuser.name, ns, { [superuser.key]: newPassword() }),
            ),
          );
          await change.entry(dir, "superuser.secret.enc.yaml", true);
          for (const [file, content] of Object.entries(files)) {
            change.write(`${dir}/${file}`, content);
            await change.entry(dir, file, true);
          }
          await change.entry(change.path(), spec.name, true);
        },
      );
      return { name: spec.name, commit: sha };
    });
  }

  async function adopt(body: Record<string, unknown>, by: string) {
    const providerName = String(body.provider ?? "");
    const provider = providers[providerName];
    if (!provider) throw new Refused(400, "no such database engine");
    const ns = String(body.namespace ?? "");
    const workload = String(body.workload ?? "");
    const name = String(body.name ?? workload);
    if (!isKubeName(name) || name.length > 50 || name === "backup")
      throw new Refused(400, "name must be a lowercase name of at most 50 characters");
    const state =
      isKubeName(ns) && isKubeName(workload) ? await provider.observe({ namespace: ns, name: workload }) : null;
    if (!state) throw new Refused(404, `no ${providerName} instance ${ns}/${workload}`);
    if (!state.superuser)
      throw new Refused(409, "its pod does not read POSTGRES_PASSWORD from a Secret, so nothing could sign in to it");
    const host = `${state.service ?? workload}.${ns}.svc`;
    return db.transaction(async (tx) => {
      const taken = await tx.query(
        "SELECT 1 FROM databases_instances WHERE name = $1 OR (namespace = $2 AND workload = $3)",
        [name, ns, workload],
      );
      if (taken.length > 0) throw new Refused(409, `${name} or ${ns}/${workload} is managed already`);
      await tx.query(
        `INSERT INTO databases_instances (name, provider, namespace, workload, origin, host, superuser_secret, superuser_key, version, created_by)
         VALUES ($1, $2, $3, $4, 'adopted', $5, $6, $7, $8, $9)`,
        [name, providerName, ns, workload, host, state.superuser?.name, state.superuser?.key, state.version, by],
      );
      const sha = await commit(
        `databases: adopt ${ns}/${workload} as ${name}`,
        () => all(tx),
        async () => {},
      );
      return { name, commit: sha };
    });
  }

  async function grant(instanceName: string, body: Record<string, unknown>, by: string) {
    const env = ctx.ports.projectEnv;
    if (!env) throw new Refused(501, "the server cannot edit env here: a deploy repository and a cipher are needed");
    const [row] = await db.query<InstanceRow>("SELECT * FROM databases_instances WHERE name = $1", [instanceName]);
    if (!row) throw new Refused(404, "unknown database instance");
    const instance = managed(row);
    const provider = providers[instance.provider];
    if (!provider || !instance.superuser) throw new Refused(409, "this instance's engine or superuser is not known");
    const project = String(body.project ?? "");
    const layer = String(body.layer ?? "_shared");
    const role = String(body.role ?? "");
    const database = String(body.database ?? role);
    const prefix = String(body.envPrefix ?? "");
    if (!isSqlName(role) || !isSqlName(database))
      throw new Refused(400, "role and database must be lowercase letters, digits and underscores");
    if (prefix && !/^[A-Z][A-Z0-9_]*_$/.test(prefix)) throw new Refused(400, "envPrefix must be like ORDERS_");
    const password = newPassword();
    const revision = createHmac("sha256", cipher.revisionKey).update(password).digest("hex").slice(0, 8);
    const secret = { name: grantSecretName(instance.name, role), key: "password" };
    let files: Record<string, string>;
    try {
      files = provider.renderAppGrant(
        {
          name: instance.name,
          ref: { namespace: instance.namespace, name: instance.workload },
          host: instance.host,
          superuser: instance.superuser,
        },
        { database, role, password: secret, revision },
      );
    } catch (err) {
      throw new Refused(400, (err as Error).message);
    }
    const [held] = await db.query<{ project_id: string }>(
      "SELECT project_id FROM databases_grants WHERE instance = $1 AND role = $2",
      [instance.name, role],
    );
    if (held && held.project_id !== project) throw new Refused(409, `${role} belongs to project ${held.project_id}`);
    if (ctx.ports.projects && !(await ctx.ports.projects.get(project))) throw new Refused(404, "unknown project");
    await db.query(
      `INSERT INTO databases_grants (instance, role, database, project_id, layer, env_prefix, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (instance, role) DO UPDATE SET database = $3, project_id = $4, layer = $5, env_prefix = $6`,
      [instance.name, role, database, project, layer, prefix, by],
    );
    // First the role, then the application's env: retrying after a failed env
    // write makes a new password and a new Job, so the two always meet.
    const grantCommit = await commit(
      `databases: grant ${role} on ${instance.name}`,
      () => all(),
      async (change, at) => {
        // A directory per grant, holding whatever the engine renders: revoking removes it whole.
        const dir = change.path(instance.name);
        const grantDir = `${dir}/grant-${dashed(role)}`;
        const secretPath = `${grantDir}/password.secret.enc.yaml`;
        change.write(
          secretPath,
          await sealed(cipher, at, secretPath, secretDocument(secret.name, instance.namespace, { password })),
        );
        await change.entry(grantDir, "password.secret.enc.yaml", true);
        const stale = (await at.list(grantDir)).filter(
          (f) => f !== "kustomization.yaml" && f !== "password.secret.enc.yaml" && !(f in files),
        );
        for (const f of stale) {
          change.write(`${grantDir}/${f}`, null);
          await change.entry(grantDir, f, false);
        }
        for (const [file, content] of Object.entries(files)) {
          change.write(`${grantDir}/${file}`, content);
          await change.entry(grantDir, file, true);
        }
        await change.entry(dir, `grant-${dashed(role)}`, true);
        await change.entry(change.path(), instance.name, true);
      },
    );
    const url = `postgres://${role}:${encodeURIComponent(password)}@${instance.host}:5432/${database}`;
    const values = {
      DATABASE_URL: url,
      PGHOST: instance.host,
      PGPORT: "5432",
      PGDATABASE: database,
      PGUSER: role,
      PGPASSWORD: password,
    };
    try {
      const envCommit = await env.setSecrets(
        project,
        layer,
        Object.fromEntries(Object.entries(values).map(([k, v]) => [`${prefix}${k}`, v])),
        by,
      );
      return { role, database, grantCommit, envCommit: envCommit.commit, env: ENV_KEYS.map((k) => `${prefix}${k}`) };
    } catch (err) {
      throw new Refused(
        502,
        `the role is committed, but the env was not written (${(err as Error).message}); grant again`,
      );
    }
  }

  async function revoke(instanceName: string, role: string, by: string) {
    const [g] = await db.query<{ project_id: string; layer: string; env_prefix: string }>(
      "SELECT project_id, layer, env_prefix FROM databases_grants WHERE instance = $1 AND role = $2",
      [instanceName, role],
    );
    if (!g) throw new Refused(404, "unknown grant");
    // The application loses its settings first; the role itself stays, with its data.
    if (ctx.ports.projectEnv) {
      await ctx.ports.projectEnv.setSecrets(
        g.project_id,
        g.layer,
        Object.fromEntries(ENV_KEYS.map((k) => [`${g.env_prefix}${k}`, null])),
        by,
      );
    }
    const sha = await commit(
      `databases: revoke ${role} on ${instanceName}`,
      () => all(),
      async (change, at) => {
        const dir = change.path(instanceName);
        const name = `grant-${dashed(role)}`;
        const inside = (await at.list(`${dir}/${name}`)).filter((f) => f !== "kustomization.yaml");
        await change.removeDir(dir, name, inside);
        // An adopted instance's directory holds only grants: it goes with the last one.
        const left = listResources((await change.read(`${dir}/kustomization.yaml`)) ?? "");
        if (left.length === 0) {
          change.write(`${dir}/kustomization.yaml`, null);
          await change.entry(change.path(), instanceName, false);
        }
      },
    );
    await db.query("DELETE FROM databases_grants WHERE instance = $1 AND role = $2", [instanceName, role]);
    return { commit: sha };
  }

  async function requestCheck(instanceName: string, by: string) {
    const [row] = await db.query<InstanceRow>("SELECT * FROM databases_instances WHERE name = $1", [instanceName]);
    if (!row) throw new Refused(404, "unknown database instance");
    const provider = providers[row.provider];
    if (!provider) throw new Refused(409, "this instance's engine is not configured");
    const { backup, restoreCheck } = section;
    if (!backup || !restoreCheck)
      throw new Refused(409, "restore checks need backup and restoreCheck in the configuration");
    const running = await db.query("SELECT 1 FROM databases_checks WHERE instance = $1 AND status = 'pending'", [
      row.name,
    ]);
    if (running.length > 0) throw new Refused(409, "a check of this instance is running already");
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const job = `${`restore-${row.name}`.slice(0, 43).replace(/-+$/, "")}-${stamp}-${randomBytes(2).toString("hex")}`;
    let files: Record<string, string>;
    try {
      files = provider.renderRestoreCheck({
        name: job,
        namespace: restoreCheck.namespace,
        storage: backup.storage,
        source: row.name,
        identity: restoreCheck.identity,
      });
    } catch (err) {
      throw new Refused(400, (err as Error).message);
    }
    const sha = await commit(
      `databases: check that ${row.name} restores`,
      () => all(),
      async (change) => {
        const dir = change.path("checks");
        for (const [file, content] of Object.entries(files)) {
          change.write(`${dir}/${file}`, content);
          await change.entry(dir, file, true);
        }
        await change.entry(change.path(), "checks", true);
      },
    );
    await db.query(
      "INSERT INTO databases_checks (job, instance, namespace, files, requested_by) VALUES ($1, $2, $3, $4::text::jsonb, $5)",
      [job, row.name, restoreCheck.namespace, JSON.stringify(Object.keys(files)), by],
    );
    return { job, commit: sha };
  }

  /** Follows pending checks: records how each Job ended and removes its manifest. */
  async function reconcileChecks(now = new Date()): Promise<number> {
    const kube = ctx.ports.kube;
    if (!kube) return 0;
    const pending = await db.query<{ job: string; namespace: string; files: string[]; requested_at: Date }>(
      "SELECT job, namespace, files, requested_at FROM databases_checks WHERE status = 'pending' ORDER BY requested_at",
    );
    let finished = 0;
    for (const c of pending) {
      const res = await kube.request("GET", `/apis/batch/v1/namespaces/${c.namespace}/jobs/${c.job}`);
      let status: "passed" | "failed" | null = null;
      let detail: string | null = null;
      if (res.status === 200) {
        const s = (JSON.parse(res.body) as { status?: { succeeded?: number; failed?: number } }).status ?? {};
        if ((s.succeeded ?? 0) > 0) status = "passed";
        else if ((s.failed ?? 0) > 0) {
          status = "failed";
          detail = "the dump did not restore to the fingerprint taken with it; see the Job's log";
        }
      } else if (res.status === 404 && now.getTime() - new Date(c.requested_at).getTime() > CHECK_APPEARS_MS) {
        status = "failed";
        detail = "the Job never appeared: is the GitOps controller applying the databases root?";
      }
      if (!status) continue;
      await commit(
        `databases: ${c.job} ${status}`,
        () => all(),
        async (change) => {
          const dir = change.path("checks");
          for (const file of c.files) {
            change.write(`${dir}/${file}`, null);
            await change.entry(dir, file, false);
          }
          if (listResources((await change.read(`${dir}/kustomization.yaml`)) ?? "").length === 0) {
            change.write(`${dir}/kustomization.yaml`, null);
            await change.entry(change.path(), "checks", false);
          }
        },
      );
      await db.query("UPDATE databases_checks SET status = $2, detail = $3, finished_at = now() WHERE job = $1", [
        c.job,
        status,
        detail,
      ]);
      finished++;
    }
    return finished;
  }

  /**
   * Deletes an instance, when deleting is turned on and nothing depends on
   * it: no grants left, and for one stardust created, a passed restore check
   * in the last day. Its manifests go; the volume claim and its data stay,
   * for a person to delete once sure. An adopted instance is only forgotten.
   */
  async function remove(instanceName: string, body: Record<string, unknown>) {
    if (!section.allowDelete) throw new Refused(403, "deleting databases is turned off (databases.allowDelete)");
    if (body.confirm !== instanceName) throw new Refused(400, "repeat the instance's name in confirm");
    const [row] = await db.query<InstanceRow>("SELECT * FROM databases_instances WHERE name = $1", [instanceName]);
    if (!row) throw new Refused(404, "unknown database instance");
    const grants = await db.query<{ role: string }>("SELECT role FROM databases_grants WHERE instance = $1", [
      row.name,
    ]);
    if (grants.length > 0) throw new Refused(409, `revoke its grants first: ${grants.map((g) => g.role).join(", ")}`);
    if (row.origin === "created") {
      const [passed] = await db.query<{ finished_at: Date }>(
        "SELECT finished_at FROM databases_checks WHERE instance = $1 AND status = 'passed' ORDER BY finished_at DESC LIMIT 1",
        [row.name],
      );
      if (!passed || Date.now() - new Date(passed.finished_at).getTime() > CHECK_VALID_MS) {
        throw new Refused(
          409,
          "check that its newest backup restores first: a passed check in the last 24 hours is needed",
        );
      }
    }
    return db.transaction(async (tx) => {
      await tx.query("DELETE FROM databases_instances WHERE name = $1", [row.name]);
      const sha = await commit(
        `databases: delete ${row.name}`,
        () => all(tx),
        async (change, at) => {
          const dir = change.path(row.name);
          const inside = (await at.list(dir)).filter((f) => f !== "kustomization.yaml");
          if (inside.length > 0 || (await at.read(`${dir}/kustomization.yaml`)) !== null) {
            await change.removeDir(change.path(), row.name, inside);
          }
        },
      );
      return {
        commit: sha,
        kept:
          row.origin === "created"
            ? `the volume claim of ${row.namespace}/${row.workload} and its data stay: delete it by hand once sure`
            : "an adopted instance is only forgotten: nothing of it was changed",
      };
    });
  }

  return { all, create, adopt, grant, revoke, commit, root, requestCheck, reconcileChecks, remove };
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
  const f = databasesFeature(ctx);
  const { db, providers } = needs(ctx);
  const obj = (b: unknown) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {});
  return [
    {
      method: "GET",
      path: "/databases",
      permission: "databases:read",
      async handle() {
        const rows = await db.query<InstanceRow>("SELECT * FROM databases_instances ORDER BY name");
        const grants = await db.query<{
          instance: string;
          role: string;
          database: string;
          project_id: string;
          layer: string;
        }>("SELECT instance, role, database, project_id, layer FROM databases_grants ORDER BY instance, role");
        const checks = await db.query<{
          instance: string;
          status: string;
          detail: string | null;
          requested_at: Date;
          finished_at: Date | null;
        }>(
          "SELECT DISTINCT ON (instance) instance, status, detail, requested_at, finished_at FROM databases_checks ORDER BY instance, requested_at DESC",
        );
        const instances = await Promise.all(
          rows.map(async (r) => {
            const state = await providers[r.provider]
              ?.observe({ namespace: r.namespace, name: r.workload })
              .catch(() => null);
            return {
              name: r.name,
              provider: r.provider,
              origin: r.origin,
              namespace: r.namespace,
              workload: r.workload,
              host: r.host,
              version: state?.version ?? r.version,
              ready: state?.ready ?? false,
              present: state !== null && state !== undefined,
              lastCheck: (() => {
                const c = checks.find((x) => x.instance === r.name);
                return c
                  ? {
                      status: c.status,
                      detail: c.detail,
                      requestedAt: new Date(c.requested_at).toISOString(),
                      finishedAt: c.finished_at ? new Date(c.finished_at).toISOString() : null,
                    }
                  : null;
              })(),
              grants: grants
                .filter((g) => g.instance === r.name)
                .map((g) => ({ role: g.role, database: g.database, project: g.project_id, layer: g.layer })),
            };
          }),
        );
        const taken = new Set(rows.map((r) => `${r.provider}/${r.namespace}/${r.workload}`));
        const unmanaged = (
          await Promise.all(
            Object.entries(providers).map(async ([name, p]) =>
              (await p.discover().catch(() => [])).map((s) => ({ provider: name, ...s })),
            ),
          )
        )
          .flat()
          .filter((s) => !taken.has(`${s.provider}/${s.ref.namespace}/${s.ref.name}`))
          .map((s) => ({
            provider: s.provider,
            namespace: s.ref.namespace,
            workload: s.ref.name,
            version: s.version,
            ready: s.ready,
            adoptable: s.superuser !== null,
          }));
        return {
          status: 200,
          body: {
            instances,
            unmanaged,
            engines: Object.entries(providers).map(([name, p]) => ({ name, ...p.capabilities })),
            backup: (ctx.config as Section).backup ? { schedule: (ctx.config as Section).backup?.schedule } : null,
            envEditing: Boolean(ctx.ports.projectEnv),
            restoreChecks: Boolean((ctx.config as Section).backup && (ctx.config as Section).restoreCheck),
            allowDelete: (ctx.config as Section).allowDelete === true,
          },
        };
      },
    },
    {
      method: "POST",
      path: "/databases",
      permission: "databases:write",
      audit: "databases.create",
      handle: ({ body, user }) =>
        wrap(async () => {
          const r = await f.create(obj(body), user.username);
          return { body: r, audit: { target: r.name, detail: { commit: r.commit } } };
        }, 201),
    },
    {
      method: "POST",
      path: "/databases/adopt",
      permission: "databases:write",
      audit: "databases.adopt",
      handle: ({ body, user }) =>
        wrap(async () => {
          const r = await f.adopt(obj(body), user.username);
          return { body: r, audit: { target: r.name, detail: { commit: r.commit } } };
        }, 201),
    },
    {
      method: "POST",
      path: "/databases/:name/grants",
      permission: "databases:write",
      audit: "databases.grant",
      handle: ({ params, body, user }) =>
        wrap(async () => {
          const r = await f.grant(params.name ?? "", obj(body), user.username);
          // The password never leaves the server: the response names the env keys only.
          return {
            body: r,
            audit: {
              target: `${params.name}/${r.role}`,
              detail: {
                database: r.database,
                project: obj(body).project,
                grantCommit: r.grantCommit,
                envCommit: r.envCommit,
              },
            },
          };
        }, 201),
    },
    {
      method: "DELETE",
      path: "/databases/:name/grants/:role",
      permission: "databases:write",
      audit: "databases.revoke",
      handle: ({ params, user }) =>
        wrap(async () => {
          const r = await f.revoke(params.name ?? "", params.role ?? "", user.username);
          return { body: r, audit: { target: `${params.name}/${params.role}`, detail: { commit: r.commit } } };
        }),
    },
    {
      method: "POST",
      path: "/databases/backup",
      permission: "databases:write",
      audit: "databases.backup.render",
      handle: () =>
        wrap(async () => {
          const sha = await f.commit(
            "databases: render backups",
            () => f.all(),
            async () => {},
          );
          return { body: { commit: sha }, audit: { target: f.root, detail: { commit: sha } } };
        }),
    },
    {
      method: "POST",
      path: "/databases/:name/restore-check",
      permission: "databases:write",
      audit: "databases.check",
      handle: ({ params, user }) =>
        wrap(async () => {
          const r = await f.requestCheck(params.name ?? "", user.username);
          return { body: r, audit: { target: params.name ?? "", detail: r } };
        }, 201),
    },
    {
      method: "POST",
      path: "/databases/:name/delete",
      permission: "databases:write",
      audit: "databases.delete",
      fresh: true,
      handle: ({ params, body }) =>
        wrap(async () => {
          const r = await f.remove(params.name ?? "", obj(body));
          return { body: r, audit: { target: params.name ?? "", detail: { commit: r.commit } } };
        }),
    },
  ];
}

export const plugin = definePlugin({
  manifest: {
    name: "databases",
    description: "PostgreSQL instances, application grants and backups, through the deploy repository.",
  },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s))
      if (!["root", "backup", "restoreCheck", "allowDelete"].includes(key)) problems.push(`unknown key "${key}"`);
    if (s.allowDelete !== undefined && typeof s.allowDelete !== "boolean")
      problems.push("allowDelete must be true or false");
    if (s.restoreCheck !== undefined) {
      const r = s.restoreCheck as { namespace?: unknown; identity?: { name?: unknown; key?: unknown } };
      if (!s.backup) problems.push("restoreCheck needs backup: it checks the backups");
      if (!isKubeName(r.namespace)) problems.push("restoreCheck.namespace must be a namespace name");
      if (!isKubeName(r.identity?.name) || typeof r.identity?.key !== "string") {
        problems.push("restoreCheck.identity must be { name: <Secret>, key: <key> } holding the age identity");
      }
    }
    if (
      s.root !== undefined &&
      (typeof s.root !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(s.root) || s.root.includes(".."))
    ) {
      problems.push("root must be a path in the deploy repository");
    }
    if (s.backup !== undefined) {
      const b = s.backup as Partial<BackupSettings>;
      const probe = backupPlanProblems({
        name: "db-backup",
        namespace: "probe",
        schedule: String(b.schedule ?? ""),
        storage: {
          endpoint: String(b.storage?.endpoint ?? ""),
          bucket: String(b.storage?.bucket ?? ""),
          credentials: String(b.storage?.credentials ?? ""),
          prefix: String(b.storage?.prefix ?? ""),
        },
        recipient: String(b.recipient ?? ""),
        retentionHours: Number(b.retentionHours ?? 168),
        targets: [
          {
            name: "probe",
            ref: { namespace: "probe", name: "probe" },
            host: "probe",
            superuser: { name: "probe", key: "k" },
          },
        ],
      });
      for (const p of probe) problems.push(`backup: ${p}`);
    }
    return problems;
  },
  requires: ["databases", "deployRepo", "cipher", "database"],
  permissions: [
    { id: "databases:read", description: "See database instances and grants", grantedTo: "admins" },
    { id: "databases:write", description: "Create, adopt and grant databases", grantedTo: "admins" },
  ],
  capabilities: ["databases.list"],
  migrations: async () => [
    { name: "0001_databases.sql", scope: "regional", sql: MIGRATION },
    { name: "0002_checks.sql", scope: "regional", sql: CHECKS_MIGRATION },
  ],
  schedules: [
    { id: "checks", everyMs: 120_000, run: async (ctx) => void (await databasesFeature(ctx).reconcileChecks()) },
  ],
  routes,
});
