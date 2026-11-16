/**
 * Database engines, as the `databases` feature sees them. A provider never
 * connects to a database and never reads a secret's value: it finds the
 * instances in the cluster, says how each is doing, and renders manifests
 * (the instance, a Job that sets up an application's role, a backup
 * CronJob) that the feature commits to the deploy repository. Secrets are
 * referred to by name and key only; the pods read them.
 *
 * Several providers can be configured at once (a StatefulSet today, an
 * operator later), each instance recording which one runs it.
 */

/** Where an instance runs: its namespace and the name of its workload. */
export interface DatabaseRef {
  namespace: string;
  name: string;
}

/** A Secret and the key in it, by name only. */
export interface SecretKeyRef {
  name: string;
  key: string;
}

export interface DatabaseState {
  ref: DatabaseRef;
  /** The Service that reaches it, when there is one. */
  service: string | null;
  image: string;
  /** The engine's major version, from the image tag when it shows one. */
  version: string | null;
  desiredReplicas: number;
  readyReplicas: number;
  ready: boolean;
  /** The superuser password's Secret, when the workload reads it from one. */
  superuser: SecretKeyRef | null;
}

/** A new instance. The provider picks the namespace. */
export interface DatabaseSpec {
  name: string;
  version: string;
  /** e.g. 10Gi */
  storage: string;
  storageClass?: string;
  /** e.g. 250m or 1 */
  cpu: string;
  /** e.g. 512Mi */
  memory: string;
}

/** An instance as the renders need it: where it is, how to reach it, whose password opens it. */
export interface DatabaseTarget {
  /** What stardust calls it, unique across namespaces: its dumps are stored under this name. */
  name: string;
  ref: DatabaseRef;
  /** Host name inside the cluster, e.g. <service>.<namespace>.svc */
  host: string;
  superuser: SecretKeyRef;
}

/** An application's own role and database on an instance. */
export interface AppGrant {
  database: string;
  role: string;
  /** The application's password, which the feature seals into the repository. */
  password: SecretKeyRef;
  /**
   * Names this version of the grant (e.g. a fingerprint of the password). A
   * Job cannot change once created, so a new password needs a new Job.
   */
  revision?: string;
}

export interface BackupPlan {
  /** The CronJob's name and namespace. */
  name: string;
  namespace: string;
  /** Cron syntax, in UTC. */
  schedule: string;
  /** Object storage reachable over the S3 API; credentials as `access-key-id` and `secret-access-key`. */
  storage: { endpoint: string; bucket: string; credentials: string; prefix: string };
  /** Dumps are encrypted to this age recipient before they leave the pod. */
  recipient: string;
  retentionHours: number;
  /** One dump per target, stored under the target's `name`. */
  targets: DatabaseTarget[];
}

/** Restoring the newest dump of one instance into a throwaway server, and comparing fingerprints. */
export interface RestoreCheck {
  /** The Job's name and namespace. */
  name: string;
  namespace: string;
  storage: BackupPlan["storage"];
  /** Whose dumps: the backed-up target's `name`. */
  source: string;
  /** The age identity that decrypts the dumps. Keep it in a namespace of its own. */
  identity: SecretKeyRef;
}

export interface DatabaseProvider {
  readonly engine: "postgres";
  readonly capabilities: {
    /** Major versions it can create. */
    versions: readonly string[];
    /** Where it creates new instances. */
    namespace: string;
  };
  /** Why a spec cannot be created, or nothing. */
  specProblems(spec: DatabaseSpec): string[];
  /** Every instance of this engine the provider can see, managed or not. */
  discover(): Promise<DatabaseState[]>;
  /** One instance, or null when it is not there. */
  observe(ref: DatabaseRef): Promise<DatabaseState | null>;
  /** The Secret a new instance's superuser password goes in. */
  superuserSecret(name: string): SecretKeyRef;
  /** Manifests for a new instance, by file name. Its password Secret is the feature's to write. */
  renderInstance(spec: DatabaseSpec): Record<string, string>;
  /** A Job that creates or updates the application's role and database; running it twice changes nothing. */
  renderAppGrant(target: DatabaseTarget, grant: AppGrant): Record<string, string>;
  /** A CronJob that fingerprints and dumps every target, encrypts, uploads, re-reads the size, and prunes. */
  renderBackup(plan: BackupPlan): Record<string, string>;
  /** A Job that succeeds only when the newest dump restores to the fingerprint taken with it. */
  renderRestoreCheck(check: RestoreCheck): Record<string, string>;
}

const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** A Kubernetes name: lowercase, digits and dashes, at most 63. */
export const isKubeName = (v: unknown): v is string => typeof v === "string" && v.length <= 63 && LABEL.test(v);
/** A SQL identifier we interpolate unquoted: so strict that quoting is never needed. */
export const isSqlName = (v: unknown): v is string => typeof v === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(v);

const mib = (v: string) => Number.parseInt(v, 10) * (v.endsWith("Gi") ? 1024 : 1);
const millicores = (v: string) => (v.endsWith("m") ? Number.parseInt(v, 10) : Number.parseInt(v, 10) * 1000);

/** The checks every engine shares: names, sizes and resources within sane bounds. */
export function databaseSpecProblems(spec: DatabaseSpec, versions: readonly string[]): string[] {
  const problems: string[] = [];
  if (!isKubeName(spec.name) || spec.name.length > 50)
    problems.push("name must be a lowercase name of at most 50 characters");
  if (!versions.includes(spec.version)) problems.push(`version must be one of ${versions.join(", ")}`);
  if (!/^[1-9][0-9]*(Mi|Gi)$/.test(spec.storage) || mib(spec.storage) > 1024 * 1024) {
    problems.push("storage must be like 10Gi, at most 1024Gi");
  }
  if (spec.storageClass !== undefined && !isKubeName(spec.storageClass)) problems.push("storageClass must be a name");
  if (!/^([1-9][0-9]*m|[1-9][0-9]*)$/.test(spec.cpu) || millicores(spec.cpu) < 50 || millicores(spec.cpu) > 4000) {
    problems.push("cpu must be 50m to 4");
  }
  if (!/^[1-9][0-9]*(Mi|Gi)$/.test(spec.memory) || mib(spec.memory) < 128 || mib(spec.memory) > 16 * 1024) {
    problems.push("memory must be 128Mi to 16Gi");
  }
  return problems;
}

/** Why a grant cannot be rendered, or nothing. */
export function appGrantProblems(grant: AppGrant): string[] {
  const problems: string[] = [];
  if (!isSqlName(grant.database)) problems.push("database must be lowercase letters, digits and underscores");
  if (!isSqlName(grant.role)) problems.push("role must be lowercase letters, digits and underscores");
  if (grant.role === "postgres") problems.push("role must not be the superuser");
  if (!isKubeName(grant.password.name)) problems.push("the password Secret must be a name");
  if (grant.revision !== undefined && !/^[a-z0-9]{1,12}$/.test(grant.revision))
    problems.push("revision must be 1 to 12 lowercase letters or digits");
  return problems;
}

/** Why a backup plan cannot be rendered, or nothing. */
export function backupPlanProblems(plan: BackupPlan): string[] {
  const problems: string[] = [];
  if (!isKubeName(plan.name) || !isKubeName(plan.namespace)) problems.push("name and namespace must be names");
  if (!/^(\S+\s+){4}\S+$/.test(plan.schedule)) problems.push("schedule must be five cron fields");
  if (!/^https:\/\/[^\s"'$`\\]+$/.test(plan.storage.endpoint)) problems.push("storage.endpoint must be an https URL");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(plan.storage.bucket))
    problems.push("storage.bucket must be a bucket name");
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(plan.storage.prefix)) problems.push("storage.prefix must be a simple path");
  if (!isKubeName(plan.storage.credentials)) problems.push("storage.credentials must be a Secret name");
  if (!/^age1[0-9a-z]{58}$/.test(plan.recipient)) problems.push("recipient must be an age public key");
  if (!Number.isInteger(plan.retentionHours) || plan.retentionHours < 24)
    problems.push("retentionHours must be at least 24");
  if (plan.targets.length === 0) problems.push("there must be something to back up");
  const seen = new Set<string>();
  for (const t of plan.targets) {
    if (!isKubeName(t.name) || !isKubeName(t.ref.name) || !isKubeName(t.superuser.name)) {
      problems.push(`${t.name}: names must be names`);
    }
    if (!/^[a-z0-9.-]+$/.test(t.host)) problems.push(`${t.name}: host must be a host name`);
    if (!/^[A-Za-z0-9._-]+$/.test(t.superuser.key)) problems.push(`${t.name}: the secret key must be a key name`);
    if (seen.has(t.name)) problems.push(`${t.name}: two targets with one name would overwrite each other's dumps`);
    seen.add(t.name);
  }
  return problems;
}

/** Why a restore check cannot be rendered, or nothing. */
export function restoreCheckProblems(check: RestoreCheck): string[] {
  const problems = backupPlanProblems({
    name: check.name,
    namespace: check.namespace,
    schedule: "0 0 * * *",
    storage: check.storage,
    recipient: `age1${"q".repeat(58)}`,
    retentionHours: 24,
    targets: [
      {
        name: check.source,
        ref: { namespace: check.namespace, name: check.source },
        host: "h",
        superuser: { name: "s", key: "k" },
      },
    ],
  });
  if (!isKubeName(check.source)) problems.push("source must be a name");
  if (!isKubeName(check.identity.name) || !/^[A-Za-z0-9._-]+$/.test(check.identity.key))
    problems.push("identity must name a Secret and key");
  return problems;
}
