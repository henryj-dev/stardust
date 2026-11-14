/**
 * PostgreSQL as a plain StatefulSet: one replica, a volume claim, a Service.
 * It finds instances by their image in the namespaces it is given (it
 * needs `get`/`list` on statefulsets there, nothing cluster-wide), and
 * reads the superuser Secret's name and key from the pod's
 * POSTGRES_PASSWORD, never the value.
 */
import {
  type AppGrant,
  appGrantProblems,
  type BackupPlan,
  backupPlanProblems,
  type DatabaseProvider,
  type DatabaseRef,
  type DatabaseSpec,
  type DatabaseState,
  type DatabaseTarget,
  databaseSpecProblems,
  type KubeClient,
  type RestoreCheck,
  restoreCheckProblems,
} from "@stardust/core";
import { stringify } from "yaml";
import { backupScript, restoreCheckScript } from "./scripts.ts";

export interface StatefulSetOptions {
  kube: KubeClient;
  /** Where new instances go. */
  namespace: string;
  /** Where to look for instances, the namespace above included. */
  namespaces: readonly string[];
  /** The image repository; the tag is `<version>-alpine`. */
  image?: string;
  versions?: readonly string[];
}

interface StatefulSetObject {
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec?: {
    replicas?: number;
    serviceName?: string;
    template?: {
      spec?: {
        containers?: Array<{
          image?: string;
          env?: Array<{ name: string; valueFrom?: { secretKeyRef?: { name?: string; key?: string } } }>;
        }>;
      };
    };
  };
  status?: { readyReplicas?: number };
}

const POSTGRES_IMAGE = /(^|\/)(postgres|postgis)(:|@|$)/;
const MANAGED = { "app.kubernetes.io/managed-by": "stardust" };
const doc = (o: unknown) => stringify(o, { lineWidth: 0 });

/** The major version from an image tag such as `17-alpine` or `16.4`. */
export function majorOf(image: string): string | null {
  const repo = image.split("@")[0] ?? "";
  const colon = repo.lastIndexOf(":");
  if (colon < 0 || colon < repo.lastIndexOf("/")) return null;
  return /^(\d+)/.exec(repo.slice(colon + 1))?.[1] ?? null;
}

function stateOf(o: StatefulSetObject): DatabaseState | null {
  const containers = o.spec?.template?.spec?.containers ?? [];
  const pg = containers.find((c) => POSTGRES_IMAGE.test(c.image ?? ""));
  if (!pg?.image) return null;
  const ref = pg.env?.find((e) => e.name === "POSTGRES_PASSWORD")?.valueFrom?.secretKeyRef;
  const desired = o.spec?.replicas ?? 1;
  const ready = o.status?.readyReplicas ?? 0;
  return {
    ref: { namespace: o.metadata.namespace, name: o.metadata.name },
    service: o.spec?.serviceName ?? null,
    image: pg.image,
    version: majorOf(pg.image),
    desiredReplicas: desired,
    readyReplicas: ready,
    ready: desired > 0 && ready >= desired,
    superuser: ref?.name && ref.key ? { name: ref.name, key: ref.key } : null,
  };
}

export function statefulSetPostgres(options: StatefulSetOptions): DatabaseProvider {
  const versions = options.versions ?? ["16", "17"];
  const image = options.image ?? "postgres";
  const namespaces = [...new Set([options.namespace, ...options.namespaces])];
  const get = async (path: string) => {
    const res = await options.kube.request("GET", path);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`kube GET ${path} answered ${res.status}`);
    return JSON.parse(res.body) as unknown;
  };
  const pgImage = (version: string) => `${image}:${version}-alpine`;
  /** The newest client dumps every older server. */
  const newest = () => [...versions].sort((a, b) => Number(b) - Number(a))[0] ?? "17";
  const passwordEnv = (name: string, ref: { name: string; key: string }) => ({
    name,
    valueFrom: { secretKeyRef: { name: ref.name, key: ref.key } },
  });

  return {
    engine: "postgres",
    capabilities: { versions, namespace: options.namespace },
    specProblems: (spec) => databaseSpecProblems(spec, versions),

    async discover() {
      const found: DatabaseState[] = [];
      for (const ns of namespaces) {
        const list = (await get(`/apis/apps/v1/namespaces/${ns}/statefulsets`)) as {
          items?: StatefulSetObject[];
        } | null;
        for (const o of list?.items ?? []) {
          const s = stateOf(o);
          if (s) found.push(s);
        }
      }
      return found.sort((a, b) => `${a.ref.namespace}/${a.ref.name}`.localeCompare(`${b.ref.namespace}/${b.ref.name}`));
    },

    async observe(ref: DatabaseRef) {
      if (!namespaces.includes(ref.namespace)) return null;
      const o = (await get(
        `/apis/apps/v1/namespaces/${ref.namespace}/statefulsets/${ref.name}`,
      )) as StatefulSetObject | null;
      return o ? stateOf(o) : null;
    },

    superuserSecret: (name) => ({ name: `${name}-superuser`, key: "password" }),

    renderInstance(spec: DatabaseSpec) {
      const problems = databaseSpecProblems(spec, versions);
      if (problems.length > 0) throw new Error(problems.join("; "));
      const ns = options.namespace;
      const labels = { "app.kubernetes.io/name": spec.name, ...MANAGED };
      const superuser = { name: `${spec.name}-superuser`, key: "password" };
      const statefulSet = {
        apiVersion: "apps/v1",
        kind: "StatefulSet",
        metadata: { name: spec.name, namespace: ns, labels },
        spec: {
          serviceName: spec.name,
          replicas: 1,
          selector: { matchLabels: { "app.kubernetes.io/name": spec.name } },
          template: {
            metadata: { labels },
            spec: {
              // The alpine image runs postgres as uid 70.
              securityContext: { fsGroup: 70, runAsUser: 70, runAsGroup: 70, runAsNonRoot: true },
              containers: [
                {
                  name: "postgres",
                  image: pgImage(spec.version),
                  ports: [{ name: "postgres", containerPort: 5432 }],
                  env: [
                    passwordEnv("POSTGRES_PASSWORD", superuser),
                    // A subdirectory: the volume's root holds lost+found, which initdb refuses.
                    { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
                  ],
                  resources: {
                    requests: { cpu: spec.cpu, memory: spec.memory },
                    limits: { memory: spec.memory },
                  },
                  readinessProbe: { exec: { command: ["pg_isready", "-U", "postgres"] }, periodSeconds: 10 },
                  livenessProbe: {
                    exec: { command: ["pg_isready", "-U", "postgres"] },
                    initialDelaySeconds: 30,
                    periodSeconds: 20,
                  },
                  securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                  volumeMounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
                },
              ],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: "data" },
              spec: {
                accessModes: ["ReadWriteOnce"],
                ...(spec.storageClass ? { storageClassName: spec.storageClass } : {}),
                resources: { requests: { storage: spec.storage } },
              },
            },
          ],
        },
      };
      const service = {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: spec.name, namespace: ns, labels },
        spec: {
          selector: { "app.kubernetes.io/name": spec.name },
          ports: [{ name: "postgres", port: 5432, targetPort: "postgres" }],
        },
      };
      return { "statefulset.yaml": doc(statefulSet), "service.yaml": doc(service) };
    },

    renderAppGrant(target: DatabaseTarget, grant: AppGrant) {
      const problems = appGrantProblems(grant);
      if (problems.length > 0) throw new Error(problems.join("; "));
      const { role, database } = grant;
      // Names are checked to be plain identifiers, so they appear unquoted; the
      // password only ever reaches SQL through psql's :'var' quoting, which psql
      // applies to what it reads, not to -c (so those statements go on stdin).
      const script = [
        "set -eu",
        'q() { psql -v ON_ERROR_STOP=1 -Atq -h "$PGHOST" -U postgres -d postgres "$@"; }',
        `if [ "$(q -c "SELECT 1 FROM pg_roles WHERE rolname = '${role}'")" = 1 ]; then VERB=ALTER; else VERB=CREATE; fi`,
        `echo "$VERB ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';" | q -v pw="$APP_PASSWORD"`,
        `if [ "$(q -c "SELECT 1 FROM pg_database WHERE datname = '${database}'")" != 1 ]; then`,
        `  q -c "CREATE DATABASE ${database} OWNER ${role}"`,
        "fi",
        `q -c "ALTER DATABASE ${database} OWNER TO ${role}"`,
        `q -c "REVOKE ALL ON DATABASE ${database} FROM PUBLIC"`,
        `echo "[ok] ${role} owns ${database}"`,
      ].join("\n");
      const suffix = grant.revision ? `-${grant.revision}` : "";
      const base = `${target.name}-grant-${role.replace(/_/g, "-")}`.slice(0, 63 - suffix.length).replace(/-+$/, "");
      const name = `${base}${suffix}`;
      const job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, namespace: target.ref.namespace, labels: { ...MANAGED, "stardust.dev/grant": role } },
        spec: {
          backoffLimit: 3,
          template: {
            spec: {
              restartPolicy: "OnFailure",
              securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70 },
              containers: [
                {
                  name: "grant",
                  image: pgImage(newest()),
                  env: [
                    { name: "PGHOST", value: target.host },
                    passwordEnv("PGPASSWORD", target.superuser),
                    passwordEnv("APP_PASSWORD", grant.password),
                  ],
                  command: ["/bin/sh", "-c", script],
                  securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                },
              ],
            },
          },
        },
      };
      return { [`grant-${role}.yaml`]: doc(job) };
    },

    renderBackup(plan: BackupPlan) {
      const problems = backupPlanProblems(plan);
      if (problems.length > 0) throw new Error(problems.join("; "));
      // One list drives the env, the dump calls and the expected count, so a
      // target cannot be half added and silently skipped.
      const envOf = (i: number) => `PW_${i}`;
      const script = backupScript(plan.targets.map((t, i) => ({ name: t.name, host: t.host, passwordEnv: envOf(i) })));
      const cron = {
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: { name: plan.name, namespace: plan.namespace, labels: MANAGED },
        spec: {
          schedule: plan.schedule,
          timeZone: "Etc/UTC",
          concurrencyPolicy: "Forbid",
          successfulJobsHistoryLimit: 3,
          failedJobsHistoryLimit: 3,
          jobTemplate: {
            spec: {
              backoffLimit: 2,
              template: {
                // A stable label for network policies: a Job pod's own labels change every run.
                metadata: { labels: { "app.kubernetes.io/name": plan.name, ...MANAGED } },
                spec: {
                  restartPolicy: "OnFailure",
                  containers: [
                    {
                      name: "backup",
                      image: pgImage(newest()),
                      env: [
                        { name: "ENDPOINT", value: plan.storage.endpoint },
                        { name: "BUCKET", value: plan.storage.bucket },
                        { name: "PREFIX", value: plan.storage.prefix },
                        { name: "RECIPIENT", value: plan.recipient },
                        { name: "RETENTION_HOURS", value: String(plan.retentionHours) },
                        { name: "AWS_DEFAULT_REGION", value: "auto" },
                        passwordEnv("AWS_ACCESS_KEY_ID", { name: plan.storage.credentials, key: "access-key-id" }),
                        passwordEnv("AWS_SECRET_ACCESS_KEY", {
                          name: plan.storage.credentials,
                          key: "secret-access-key",
                        }),
                        ...plan.targets.map((t, i) => passwordEnv(envOf(i), t.superuser)),
                      ],
                      command: ["/bin/sh", "-c", script],
                    },
                  ],
                },
              },
            },
          },
        },
      };
      return { [`${plan.name}.yaml`]: doc(cron) };
    },

    renderRestoreCheck(check: RestoreCheck) {
      const problems = restoreCheckProblems(check);
      if (problems.length > 0) throw new Error(problems.join("; "));
      const job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: check.name,
          namespace: check.namespace,
          labels: { ...MANAGED, "stardust.dev/restore-check": check.source },
        },
        spec: {
          // One try: a failed check is an answer, not something to retry.
          backoffLimit: 0,
          activeDeadlineSeconds: 3600,
          template: {
            metadata: { labels: { "app.kubernetes.io/name": "db-restore-check", ...MANAGED } },
            spec: {
              restartPolicy: "Never",
              containers: [
                {
                  name: "restore-check",
                  image: pgImage(newest()),
                  env: [
                    { name: "ENDPOINT", value: check.storage.endpoint },
                    { name: "BUCKET", value: check.storage.bucket },
                    { name: "PREFIX", value: check.storage.prefix },
                    { name: "SOURCE", value: check.source },
                    { name: "AWS_DEFAULT_REGION", value: "auto" },
                    passwordEnv("AWS_ACCESS_KEY_ID", { name: check.storage.credentials, key: "access-key-id" }),
                    passwordEnv("AWS_SECRET_ACCESS_KEY", { name: check.storage.credentials, key: "secret-access-key" }),
                  ],
                  command: ["/bin/sh", "-c", restoreCheckScript()],
                  volumeMounts: [
                    { name: "work", mountPath: "/work" },
                    { name: "identity", mountPath: "/identity", readOnly: true },
                  ],
                },
              ],
              volumes: [
                { name: "work", emptyDir: {} },
                {
                  name: "identity",
                  secret: {
                    secretName: check.identity.name,
                    defaultMode: 0o400,
                    items: [{ key: check.identity.key, path: "key" }],
                  },
                },
              ],
            },
          },
        },
      };
      return { [`${check.name}.yaml`]: doc(job) };
    },
  };
}
