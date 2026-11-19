/**
 * A component's persistent storage, read from and written to its deploy
 * directory (see @stardust/core gitops/storage): a claim file per volume,
 * listed in the kustomization, and the mounts in its workloads, as one commit.
 *
 * Data is never deleted by accident: unmounting a volume keeps its claim
 * (the claim file stays, so the GitOps controller keeps it), and only a
 * volume named in `deleteData` loses its file, which is what removes the
 * claim and its data. A size only grows, and a claim's class never changes.
 */
import {
  addResource,
  type BoundRepo,
  commitWithCas,
  findWorkloads,
  type RepoIO,
  readFsGroup,
  readStorageClaim,
  readStorageMounts,
  removeResource,
  STORAGE_VOLUME_PREFIX,
  type StorageVolume,
  setStorageClaimSize,
  setStorageMounts,
  storageClaimDocument,
  storageClaimName,
  storageFile,
  storageMebibytes,
  storageVolumeName,
} from "@stardust/core";
import type { Component } from "@stardust/db";
import { manifests, namespaceOf } from "./access.ts";

export class StorageInputError extends Error {}
export class StorageConflict extends Error {}

const dirOf = (c: Pick<Component, "deployDir">) => c.deployDir.replace(/\/+$/, "");
const KUSTOMIZATIONS = ["kustomization.yaml", "kustomization.yml"];
const CLAIM_FILE = new RegExp(`/${STORAGE_VOLUME_PREFIX}([a-z0-9-]+)\\.pvc\\.yaml$`);

export interface StorageEntry extends StorageVolume {
  /** The claim's name. */
  claim: string;
  /** Whether stardust holds the claim's file; a claim taken over may live elsewhere. */
  claimFile: boolean;
}

export interface ComponentStorage {
  namespace: string | null;
  /** Volumes stardust mounts. Size and class are null for a claim stardust does not hold. */
  volumes: Array<Omit<StorageEntry, "size"> & { size: string | null }>;
  /** Claims stardust holds whose volume is not mounted: their data is kept. */
  kept: Array<{ name: string; claim: string; size: string | null }>;
  /** The workload's own claim volumes, which can be taken over. */
  other: Array<{ volume: string; claim: string; mountPath: string | null }>;
  fsGroup: number | null;
}

const isWorkloadFile = (path: string) =>
  !CLAIM_FILE.test(path) && !/\/env\.[^/]+$/.test(path) && !KUSTOMIZATIONS.some((k) => path.endsWith(`/${k}`));

function snapshot(files: ReadonlyMap<string, string>, component: Component, dir: string): ComponentStorage {
  const claims = new Map<string, { size: string | null; storageClass: string | null }>();
  for (const [path, text] of files) {
    const m = CLAIM_FILE.exec(path);
    if (m?.[1]) claims.set(m[1], readStorageClaim(text));
  }
  const volumes: ComponentStorage["volumes"] = [];
  const other: ComponentStorage["other"] = [];
  let fsGroup: number | null = null;
  for (const [path, text] of files) {
    if (!isWorkloadFile(path)) continue;
    let found: ReturnType<typeof readStorageMounts>;
    try {
      found = readStorageMounts(text, component.name);
    } catch {
      continue;
    }
    fsGroup ??= readFsGroup(text);
    for (const m of found.managed) {
      const name = m.volume.slice(STORAGE_VOLUME_PREFIX.length);
      if (volumes.some((v) => v.name === name)) continue;
      const held = claims.get(name);
      const ownClaim = m.claim === storageClaimName(component.name, name) && held !== undefined;
      volumes.push({
        name,
        mountPath: m.mountPath ?? "",
        claim: m.claim,
        claimFile: ownClaim,
        size: ownClaim ? (held?.size ?? null) : null,
        ...(ownClaim && held?.storageClass ? { storageClass: held.storageClass } : {}),
      });
    }
    for (const m of found.other) if (!other.some((o) => o.volume === m.volume)) other.push(m);
  }
  const kept = [...claims]
    .filter(([name]) => !volumes.some((v) => v.name === name && v.claimFile))
    .map(([name, c]) => ({ name, claim: storageClaimName(component.name, name), size: c.size }));
  const ns = namespaceOf(files, dir);
  return { namespace: typeof ns === "string" ? ns : null, volumes, kept, other, fsGroup };
}

export async function readStorage(repo: RepoIO, component: Component): Promise<ComponentStorage> {
  const head = await repo.headSha();
  const at: BoundRepo = { read: (p) => repo.readFile(p, head), list: (p) => repo.listDir(p, head) };
  const dir = dirOf(component);
  return snapshot(await manifests(at, dir), component, dir);
}

export interface StorageChange {
  volumes: StorageVolume[];
  /** Workload volumes to take over, by pod volume name. */
  adopt?: string[];
  /** Kept or unmounted volumes whose data is deleted (their claim files removed). */
  deleteData?: string[];
  /** The pod's fsGroup; null removes it, absent leaves it. */
  fsGroup?: number | null;
}

/** The changes (path → text, or null to delete) that give the component this storage. */
function planStorage(
  files: ReadonlyMap<string, string>,
  component: Component,
  change: StorageChange,
): Map<string, string | null> {
  const dir = dirOf(component);
  if (findWorkloads(files).length === 0) {
    throw new StorageInputError(`${dir} has no Deployment, StatefulSet or DaemonSet to mount storage into`);
  }
  const now = snapshot(files, component, dir);
  const out = new Map<string, string | null>();
  const kustomization = KUSTOMIZATIONS.map((k) => `${dir}/${k}`).find((p) => files.has(p));
  let listing = kustomization ? (files.get(kustomization) ?? null) : null;
  const list = (entry: string, on: boolean) => {
    if (listing === null) {
      if (on) throw new StorageInputError(`${dir} has no kustomization.yaml to list ${entry} in`);
      return;
    }
    try {
      listing = on ? addResource(listing, entry) : removeResource(listing, entry);
    } catch (err) {
      throw new StorageInputError(`${kustomization}: ${(err as Error).message}`);
    }
  };

  // Taking over a workload's volume: the pod volume gets stardust's name, the claim stays where it is.
  const rename = new Map<string, string>();
  for (const volume of change.adopt ?? []) {
    const o = now.other.find((x) => x.volume === volume);
    if (!o) throw new StorageInputError(`${component.name} mounts no claim volume named ${volume}`);
    const prefix = `${component.name}-`;
    const name = (o.claim.startsWith(prefix) ? o.claim.slice(prefix.length) : volume)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    if (!name) throw new StorageInputError(`cannot name the volume ${volume}`);
    rename.set(volume, storageVolumeName(name));
  }

  const deleting = new Set(change.deleteData ?? []);
  const mounts: Array<{ volume: string; claim: string; mountPath: string }> = [];
  for (const v of change.volumes) {
    if (deleting.has(v.name)) throw new StorageInputError(`${v.name} is mounted: unmount it before deleting its data`);
    const path = `${dir}/${storageFile(v.name)}`;
    const current = now.volumes.find((x) => x.name === v.name);
    const adopted = [...rename].find(([, n]) => n === storageVolumeName(v.name));
    const claimOf =
      current && !current.claimFile
        ? current.claim
        : adopted
          ? (now.other.find((o) => o.volume === adopted[0])?.claim ?? storageClaimName(component.name, v.name))
          : storageClaimName(component.name, v.name);
    const held = files.get(path);
    if (held !== undefined) {
      const c = readStorageClaim(held);
      if (c.storageClass && v.storageClass && c.storageClass !== v.storageClass) {
        throw new StorageInputError(`${v.name} is on ${c.storageClass}: a claim's StorageClass cannot change`);
      }
      if (c.size && storageMebibytes(v.size) < storageMebibytes(c.size)) {
        throw new StorageInputError(`${v.name} is ${c.size}: storage can grow, not shrink`);
      }
      if (c.size !== v.size) out.set(path, setStorageClaimSize(held, v.size));
    } else if (!(current && !current.claimFile) && !adopted) {
      if (!now.namespace) throw new StorageInputError(`cannot tell which namespace ${component.name} runs in`);
      out.set(path, storageClaimDocument({ component: component.name, namespace: now.namespace, volume: v }));
      list(storageFile(v.name), true);
    }
    mounts.push({ volume: storageVolumeName(v.name), claim: claimOf, mountPath: v.mountPath });
  }
  for (const name of deleting) {
    const path = `${dir}/${storageFile(name)}`;
    if (!files.has(path))
      throw new StorageInputError(`stardust holds no claim named ${storageClaimName(component.name, name)}`);
    out.set(path, null);
    list(storageFile(name), false);
  }

  let workloads = 0;
  for (const [path, text] of files) {
    if (!isWorkloadFile(path)) continue;
    let edited: ReturnType<typeof setStorageMounts>;
    try {
      edited = setStorageMounts(text, {
        component: component.name,
        mounts,
        rename,
        ...(change.fsGroup !== undefined ? { fsGroup: change.fsGroup } : {}),
      });
    } catch (err) {
      throw new StorageInputError(`${path}: ${(err as Error).message}`);
    }
    workloads += edited.workloads;
    if (edited.changed) out.set(path, edited.text);
  }
  if (workloads === 0)
    throw new StorageInputError(`${dir} has no Deployment, StatefulSet or DaemonSet to mount storage into`);
  if (kustomization && listing !== null && listing !== files.get(kustomization)) out.set(kustomization, listing);
  return out;
}

/** Sets a component's storage as one commit. */
export async function writeStorage(
  repo: RepoIO,
  input: { project: string; component: Component; change: StorageChange; by: string },
): Promise<{ status: "committed" | "no_change"; commit: string | null }> {
  const dir = dirOf(input.component);
  const result = await commitWithCas(repo, async (_head, at) => {
    const files = planStorage(await manifests(at, dir), input.component, input.change);
    if (files.size === 0) return null;
    const parts = [
      input.change.volumes.length === 0
        ? "no volumes"
        : input.change.volumes.map((v) => `${v.name} ${v.size} at ${v.mountPath}`).join(", "),
      ...(input.change.adopt?.length ? [`took over ${input.change.adopt.join(", ")}`] : []),
      ...(input.change.deleteData?.length ? [`deleted the data of ${input.change.deleteData.join(", ")}`] : []),
    ];
    return {
      files,
      message: `chore(${input.project}/${input.component.name}): storage — ${parts.join("; ")}\n\nBy ${input.by}.`,
    };
  });
  if (result.status === "error") {
    if (result.kind === "stale_head" || result.kind === "ref_race") {
      throw new StorageConflict("the deploy repository kept changing; try again");
    }
    throw new Error(`committing the storage failed: ${result.message}`);
  }
  return { status: result.status, commit: result.status === "committed" ? result.sha : null };
}
