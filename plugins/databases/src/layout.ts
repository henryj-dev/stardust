/**
 * Where the databases feature keeps its manifests in the deploy repository,
 * and how one change becomes one commit. Pure: given what is in the
 * repository and the instances stardust manages, it returns the files to
 * write.
 *
 *   <root>/kustomization.yaml          every instance directory and backup/<namespace>
 *   <root>/<instance>/                 its manifests (created ones), its grants
 *   <root>/backup/<namespace>/         that namespace's backup CronJob
 *
 * A backup CronJob runs in each namespace that holds instances, since a pod
 * can only read Secrets in its own namespace.
 */
import {
  addResource,
  type BackupPlan,
  type BoundRepo,
  type DatabaseProvider,
  type DatabaseTarget,
  listResources,
  type PendingCommit,
  removeResource,
} from "@stardust/core";
import { stringify } from "yaml";

export interface ManagedInstance {
  name: string;
  provider: string;
  namespace: string;
  workload: string;
  host: string;
  superuser: { name: string; key: string } | null;
}

export interface BackupSettings {
  schedule: string;
  storage: { endpoint: string; bucket: string; credentials: string; prefix: string };
  recipient: string;
  retentionHours: number;
}

const EMPTY_KUSTOMIZATION = "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n";

/** A Secret document, plain: the caller seals it before it is written. */
export function secretDocument(name: string, namespace: string, data: Record<string, string>): string {
  return stringify(
    { apiVersion: "v1", kind: "Secret", metadata: { name, namespace }, type: "Opaque", stringData: data },
    { lineWidth: 0 },
  );
}

export const targetOf = (i: ManagedInstance): DatabaseTarget | null =>
  i.superuser
    ? { name: i.name, ref: { namespace: i.namespace, name: i.workload }, host: i.host, superuser: i.superuser }
    : null;

/**
 * A change under the root, written against what the repository holds now:
 * files to write or delete, kustomization entries to add or remove.
 */
export class RootChange {
  readonly files: PendingCommit = new Map();
  private readonly root: string;
  private readonly at: BoundRepo;
  private readonly lists = new Map<string, string>();

  constructor(root: string, at: BoundRepo) {
    this.root = root.replace(/\/+$/, "");
    this.at = at;
  }

  path(...parts: string[]) {
    return [this.root, ...parts].join("/");
  }

  write(path: string, content: string | null) {
    this.files.set(path, content);
  }

  async read(path: string): Promise<string | null> {
    if (this.files.has(path)) return this.files.get(path) ?? null;
    return (await this.at.read(path))?.content ?? null;
  }

  private async list(dir: string): Promise<string> {
    const path = `${dir}/kustomization.yaml`;
    const cached = this.lists.get(path);
    if (cached !== undefined) return cached;
    return (await this.read(path)) ?? EMPTY_KUSTOMIZATION;
  }

  /** Lists (or with `present` false, unlists) `entry` in `dir`'s kustomization. */
  async entry(dir: string, entry: string, present: boolean) {
    const before = await this.list(dir);
    const has = listResources(before).includes(entry);
    if (has === present) return;
    const after = present ? addResource(before, entry) : removeResource(before, entry);
    this.lists.set(`${dir}/kustomization.yaml`, after);
    this.write(`${dir}/kustomization.yaml`, after);
  }

  /** Removes a directory the feature wrote, and its entry in the parent. */
  async removeDir(parent: string, name: string, files: string[]) {
    for (const f of files) this.write(`${parent}/${name}/${f}`, null);
    this.write(`${parent}/${name}/kustomization.yaml`, null);
    await this.entry(parent, name, false);
  }
}

/**
 * Renders every namespace's backup CronJob for these instances, and removes
 * the ones of namespaces that no longer hold any.
 */
export async function planBackups(
  change: RootChange,
  instances: readonly ManagedInstance[],
  providers: Readonly<Record<string, DatabaseProvider>>,
  settings: BackupSettings | undefined,
): Promise<void> {
  const byNamespace = new Map<string, { provider: DatabaseProvider; targets: DatabaseTarget[] }>();
  if (settings) {
    for (const i of instances) {
      const target = targetOf(i);
      const provider = providers[i.provider];
      if (!target || !provider) continue;
      const group = byNamespace.get(i.namespace) ?? { provider, targets: [] };
      group.targets.push(target);
      byNamespace.set(i.namespace, group);
    }
  }
  const backupDir = change.path("backup");
  const existing = listResources((await change.read(`${backupDir}/kustomization.yaml`)) ?? EMPTY_KUSTOMIZATION);
  for (const ns of existing) {
    if (!byNamespace.has(ns)) await change.removeDir(backupDir, ns, ["db-backup.yaml"]);
  }
  for (const [ns, { provider, targets }] of [...byNamespace].sort(([a], [b]) => a.localeCompare(b))) {
    const plan: BackupPlan = {
      name: "db-backup",
      namespace: ns,
      schedule: settings?.schedule ?? "",
      storage: settings?.storage ?? { endpoint: "", bucket: "", credentials: "", prefix: "" },
      recipient: settings?.recipient ?? "",
      retentionHours: settings?.retentionHours ?? 0,
      targets: targets.sort((a, b) => a.name.localeCompare(b.name)),
    };
    const files = provider.renderBackup(plan);
    for (const [file, content] of Object.entries(files)) {
      if ((await change.read(`${backupDir}/${ns}/${file}`)) !== content)
        change.write(`${backupDir}/${ns}/${file}`, content);
      await change.entry(`${backupDir}/${ns}`, file, true);
    }
    await change.entry(backupDir, ns, true);
  }
  if (byNamespace.size > 0) await change.entry(change.path(), "backup", true);
  else if (existing.length > 0 || (await change.read(`${backupDir}/kustomization.yaml`)) !== null) {
    change.write(`${backupDir}/kustomization.yaml`, null);
    await change.entry(change.path(), "backup", false);
  }
}
