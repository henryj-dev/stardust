/**
 * Persistent storage a component's containers write to: a PersistentVolumeClaim
 * per volume, mounted at a path, kept when the volume is unmounted unless the
 * data is deleted on purpose.
 *
 * The names are the contract that lets stardust tell its volumes from the
 * workload's own, and take over a claim made by hand without making it again
 * (making it again would lose the data):
 *
 * - the claim is `<component>-<name>`, in `storage-<name>.pvc.yaml` next to the
 *   component's manifests, listed in its kustomization;
 * - the pod volume is `storage-<name>`, mounted in the component's container.
 *
 * A workload's other volumes are left alone. With a volume, a Deployment rolls
 * one pod at a time with the old one stopped first (maxSurge 0, maxUnavailable
 * 1): a ReadWriteOnce claim is written by one pod. The strategy type is not
 * switched to Recreate, which a live object with RollingUpdate defaults refuses.
 */
import { isMap, isSeq, parseAllDocuments, parseDocument, stringify, type YAMLMap, type YAMLSeq } from "yaml";

export const STORAGE_VOLUME_PREFIX = "storage-";

export interface StorageVolume {
  /** Lower-case name, part of the claim and file names. */
  name: string;
  /** Where the volume appears in the container: an absolute path. */
  mountPath: string;
  /** Requested size, e.g. `1Gi`. */
  size: string;
  /** The StorageClass; the cluster's default when absent. */
  storageClass?: string;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const NAME = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/;
const SIZE = /^([1-9][0-9]{0,6})(Mi|Gi|Ti)$/;
const DNS = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;

export const storageClaimName = (component: string, name: string) => `${component}-${name}`;
export const storageVolumeName = (name: string) => `${STORAGE_VOLUME_PREFIX}${name}`;
export const storageFile = (name: string) => `${STORAGE_VOLUME_PREFIX}${name}.pvc.yaml`;

/** A size in mebibytes, for comparing two sizes. */
export function storageMebibytes(size: string): number {
  const m = SIZE.exec(size);
  if (!m) throw new Error(`${size} is not a size such as 512Mi, 10Gi or 1Ti`);
  return Number(m[1]) * { Mi: 1, Gi: 1024, Ti: 1024 * 1024 }[m[2] as "Mi" | "Gi" | "Ti"];
}

/** Checks the volumes asked for; the reasons name volumes and paths. */
export function checkStorage(component: string, volumes: unknown): StorageVolume[] {
  if (!Array.isArray(volumes)) throw new Error("volumes must be a list");
  if (volumes.length > 16) throw new Error("at most 16 volumes");
  const names = new Set<string>();
  const paths = new Set<string>();
  return volumes.map((v, i) => {
    const { name, mountPath, size, storageClass } = (v ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new Error(`volumes.${i}.name must be lower-case letters, digits and dashes (at most 24)`);
    }
    if (storageClaimName(component, name).length > 63) {
      throw new Error(`volumes.${i}.name is too long for a claim named ${storageClaimName(component, name)}`);
    }
    if (typeof mountPath !== "string" || !mountPath.startsWith("/") || mountPath.length > 1024 || mountPath === "/") {
      throw new Error(`volumes.${i}.mountPath must be an absolute path`);
    }
    if (
      mountPath
        .slice(1)
        .split("/")
        .some((s) => !SEGMENT.test(s) || s === "." || s === "..")
    ) {
      throw new Error(`volumes.${i}.mountPath must be a plain absolute path, without . or .. or empty parts`);
    }
    if (typeof size !== "string") throw new Error(`volumes.${i}.size must be a size such as 1Gi`);
    storageMebibytes(size);
    if (storageClass !== undefined && (typeof storageClass !== "string" || !DNS.test(storageClass))) {
      throw new Error(`volumes.${i}.storageClass must be a StorageClass name`);
    }
    if (names.has(name)) throw new Error(`the volume ${name} is listed twice`);
    if (paths.has(mountPath)) throw new Error(`${mountPath} is mounted twice`);
    names.add(name);
    paths.add(mountPath);
    return { name, mountPath, size, ...(storageClass ? { storageClass } : {}) };
  });
}

/** The claim of one volume, as the file stardust writes. */
export function storageClaimDocument(input: { component: string; namespace: string; volume: StorageVolume }): string {
  const { component, namespace, volume } = input;
  const doc = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: storageClaimName(component, volume.name),
      namespace,
      labels: { "app.kubernetes.io/managed-by": "stardust", "stardust.io/component": component },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      ...(volume.storageClass ? { storageClassName: volume.storageClass } : {}),
      resources: { requests: { storage: volume.size } },
    },
  };
  return (
    `# Storage "${volume.name}" of ${component}, written by stardust. Removing it from the component's Storage\n` +
    "# keeps this claim and its data; only deleting the data removes the file.\n" +
    stringify(doc)
  );
}

/** Size and class of a claim file stardust wrote (or one written the same way). */
export function readStorageClaim(text: string): { size: string | null; storageClass: string | null } {
  const doc = parseDocument(text);
  const size = doc.getIn(["spec", "resources", "requests", "storage"]);
  const cls = doc.getIn(["spec", "storageClassName"]);
  return { size: typeof size === "string" ? size : null, storageClass: typeof cls === "string" ? cls : null };
}

/** Returns the claim file with a new size. */
export function setStorageClaimSize(text: string, size: string): string {
  const doc = parseDocument(text);
  doc.setIn(["spec", "resources", "requests", "storage"], size);
  return doc.toString();
}

type Map_ = YAMLMap<unknown, unknown>;

function containerOf(spec: YAMLMap, component: string): Map_ | null {
  const containers = spec.get("containers", true);
  if (!isSeq(containers)) return null;
  const maps = containers.items.filter(isMap) as Map_[];
  return maps.find((c) => c.get("name") === component) ?? maps[0] ?? null;
}

export interface MountedClaim {
  /** The pod volume's name. */
  volume: string;
  claim: string;
  mountPath: string | null;
}

/**
 * The claims a component's workloads mount: stardust's (`storage-<name>`) and
 * the workload's own, which can be taken over.
 */
export function readStorageMounts(text: string, component: string): { managed: MountedClaim[]; other: MountedClaim[] } {
  const managed: MountedClaim[] = [];
  const other: MountedClaim[] = [];
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0 || !WORKLOADS.has(String(doc.get("kind")))) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (!isMap(spec)) continue;
    const volumes = spec.get("volumes", true);
    if (!isSeq(volumes)) continue;
    const mounts = containerOf(spec, component)?.get("volumeMounts", true);
    for (const v of volumes.items) {
      if (!isMap(v)) continue;
      const claim = v.getIn(["persistentVolumeClaim", "claimName"]);
      const volume = v.get("name");
      if (typeof claim !== "string" || typeof volume !== "string") continue;
      const mount = isSeq(mounts)
        ? (mounts.items.find((m) => isMap(m) && m.get("name") === volume) as Map_ | undefined)
        : undefined;
      const path = mount?.get("mountPath");
      const entry = { volume, claim, mountPath: typeof path === "string" ? path : null };
      const list = volume.startsWith(STORAGE_VOLUME_PREFIX) ? managed : other;
      if (!list.some((x) => x.volume === volume)) list.push(entry);
    }
  }
  return { managed, other };
}

/** The fsGroup a manifest's workloads run with, when they agree on one. */
export function readFsGroup(text: string): number | null {
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0 || !WORKLOADS.has(String(doc.get("kind")))) continue;
    const g = doc.getIn(["spec", "template", "spec", "securityContext", "fsGroup"]);
    if (typeof g === "number") return g;
  }
  return null;
}

function withoutManaged(parent: YAMLMap, field: string, managed: (item: unknown) => boolean): YAMLSeq | null {
  const list = parent.get(field, true);
  if (!isSeq(list)) return null;
  list.items = list.items.filter((item) => !managed(item));
  return list;
}

/**
 * Mounts exactly these claims in the component's workloads, replacing what
 * stardust mounted before. `claims` are pod volume name → claim and path.
 * `rename` turns a workload's own volume into stardust's (taking it over):
 * the claim stays, only the pod volume's name changes. `fsGroup`, when given,
 * is set on the pod (null removes it).
 */
export function setStorageMounts(
  text: string,
  input: {
    component: string;
    mounts: ReadonlyArray<{ volume: string; claim: string; mountPath: string }>;
    rename?: ReadonlyMap<string, string>;
    fsGroup?: number | null;
  },
): { text: string; workloads: number; changed: boolean } {
  const docs = parseAllDocuments(text);
  let workloads = 0;
  let changed = false;
  const renamed = input.rename ?? new Map<string, string>();
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new Error(`cannot parse manifest: ${doc.errors[0]?.message}`);
    const kind = String(doc.get("kind"));
    if (!WORKLOADS.has(kind)) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (!isMap(spec)) continue;
    const container = containerOf(spec, input.component);
    if (!container) continue;
    workloads++;
    const before = doc.toString();
    const name = String(doc.getIn(["metadata", "name"]));

    // Taking over: the workload's own volume is stardust's from now on, under its new name.
    const isOurs = (item: unknown) => {
      if (!isMap(item)) return false;
      const n = String(item.get("name"));
      return n.startsWith(STORAGE_VOLUME_PREFIX) || renamed.has(n);
    };
    const existing = container.get("volumeMounts", true);
    const taken = new Set(
      isSeq(existing)
        ? existing.items.filter((m) => isMap(m) && !isOurs(m)).map((m) => String((m as YAMLMap).get("mountPath")))
        : [],
    );
    const clash = input.mounts.find((m) => taken.has(m.mountPath));
    if (clash) throw new Error(`${clash.mountPath} is already a mount of another volume in ${name}`);
    const otherVolumes = spec.get("volumes", true);
    const otherNames = new Set(
      isSeq(otherVolumes)
        ? otherVolumes.items.filter((v) => isMap(v) && !isOurs(v)).map((v) => String((v as YAMLMap).get("name")))
        : [],
    );
    const named = input.mounts.find((m) => otherNames.has(m.volume));
    if (named) throw new Error(`${name} already has a volume named ${named.volume}`);

    // Already as asked (a manifest written by hand under stardust's names, in its own style): leave it be.
    const want = JSON.stringify([...input.mounts].map((m) => [m.volume, m.claim, m.mountPath]).sort());
    const have = JSON.stringify(
      (isSeq(otherVolumes) ? otherVolumes.items : [])
        .filter((v) => isOurs(v))
        .map((v) => {
          const vm = v as YAMLMap;
          const n = String(vm.get("name"));
          const m = isSeq(existing)
            ? (existing.items.find((x) => isMap(x) && x.get("name") === n) as YAMLMap | undefined)
            : undefined;
          return [n, String(vm.getIn(["persistentVolumeClaim", "claimName"])), String(m?.get("mountPath"))];
        })
        .sort(),
    );
    const strategyOk =
      kind !== "Deployment" ||
      input.mounts.length === 0 ||
      doc.getIn(["spec", "strategy", "type"]) === "Recreate" ||
      (doc.getIn(["spec", "strategy", "rollingUpdate", "maxSurge"]) === 0 &&
        doc.getIn(["spec", "strategy", "rollingUpdate", "maxUnavailable"]) === 1);
    const unchangedMounts = want === have && renamed.size === 0 && strategyOk;

    const volumes = unchangedMounts ? null : withoutManaged(spec, "volumes", isOurs);
    const mounts = unchangedMounts ? null : withoutManaged(container, "volumeMounts", isOurs);
    if (!unchangedMounts && input.mounts.length > 0) {
      const vs = input.mounts.map((m) =>
        doc.createNode({ name: m.volume, persistentVolumeClaim: { claimName: m.claim } }),
      );
      if (volumes) volumes.items.unshift(...vs);
      else spec.set("volumes", doc.createNode(vs.map((v) => v.toJSON())));
      const ms = input.mounts.map((m) => doc.createNode({ name: m.volume, mountPath: m.mountPath }));
      if (mounts) mounts.items.push(...ms);
      else container.set("volumeMounts", doc.createNode(ms.map((m) => m.toJSON())));
      if (kind === "Deployment") {
        const type = doc.getIn(["spec", "strategy", "type"]);
        // One pod writes a ReadWriteOnce claim. Recreate already does that; anything else rolls one at a time.
        if (type !== "Recreate") {
          doc.setIn(
            ["spec", "strategy"],
            doc.createNode({ type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } }),
          );
        }
      }
    }
    if (volumes && volumes.items.length === 0) spec.delete("volumes");
    if (mounts && mounts.items.length === 0) container.delete("volumeMounts");
    if (input.fsGroup !== undefined) {
      if (input.fsGroup === null) {
        const sc = spec.get("securityContext", true);
        if (isMap(sc)) {
          sc.delete("fsGroup");
          if (sc.items.length === 0) spec.delete("securityContext");
        }
      } else if (doc.getIn(["spec", "template", "spec", "securityContext", "fsGroup"]) !== input.fsGroup) {
        doc.setIn(["spec", "template", "spec", "securityContext", "fsGroup"], input.fsGroup);
      }
    }
    if (doc.toString() !== before) changed = true;
  }
  if (!changed) return { text, workloads, changed };
  const out = docs
    .map((d, i) => {
      const s = d.toString();
      return i > 0 && !s.startsWith("---") ? `---\n${s}` : s;
    })
    .join("");
  return { text: out, workloads, changed };
}
