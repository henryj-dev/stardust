/**
 * Secret values a component reads as files: keys of its env Secret mounted
 * at paths in its container (a key, a JSON credential, a config file), for
 * programs that read their credentials from disk rather than the environment.
 *
 * One volume, `stardust-files`, holds exactly the keys mounted, and each key
 * is mounted on its own path with `subPath`, so a file at /etc/app/key.pem
 * does not hide the rest of /etc/app. A subPath mount does not follow later
 * changes to the Secret by itself; an env change rolls the workload out
 * (the volume counts as reading the env), so the new files are mounted then.
 */
import { isMap, isSeq, parseAllDocuments, type YAMLMap, type YAMLSeq } from "yaml";

/** The volume stardust manages. A workload's other volumes are left alone. */
export const FILES_VOLUME = "stardust-files";

export interface FileMount {
  /** A key of the component's env Secret. */
  key: string;
  /** Where the file appears in the container: an absolute path. */
  path: string;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/** Checks a list of mounts; the reasons name keys and paths, never values. */
export function checkFileMounts(mounts: unknown): FileMount[] {
  if (!Array.isArray(mounts)) throw new Error("mounts must be a list");
  if (mounts.length > 64) throw new Error("at most 64 files");
  const paths = new Set<string>();
  return mounts.map((m, i) => {
    const { key, path } = (m ?? {}) as { key?: unknown; path?: unknown };
    if (typeof key !== "string" || !KEY.test(key)) throw new Error(`mounts.${i}.key must be an env name`);
    if (typeof path !== "string" || !path.startsWith("/") || path.length > 1024) {
      throw new Error(`mounts.${i}.path must be an absolute path`);
    }
    const segments = path.slice(1).split("/");
    if (segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) {
      throw new Error(`mounts.${i}.path must be a plain absolute path, without . or .. or empty parts`);
    }
    if (paths.has(path)) throw new Error(`${path} is mounted twice`);
    paths.add(path);
    return { key, path };
  });
}

type Container = YAMLMap<unknown, unknown>;

/** The container stardust mounts into: the one named after the component, else the first. */
function containerOf(spec: YAMLMap, component: string): Container | null {
  const containers = spec.get("containers", true);
  if (!isSeq(containers)) return null;
  const maps = containers.items.filter(isMap) as Container[];
  return maps.find((c) => c.get("name") === component) ?? maps[0] ?? null;
}

/** The mounts stardust manages in a manifest's workloads, as they are now. */
export function readFileMounts(text: string, component: string): FileMount[] {
  const found: FileMount[] = [];
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0 || !WORKLOADS.has(String(doc.get("kind")))) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (!isMap(spec)) continue;
    const mounts = containerOf(spec, component)?.get("volumeMounts", true);
    if (!isSeq(mounts)) continue;
    for (const m of mounts.items) {
      if (!isMap(m) || m.get("name") !== FILES_VOLUME) continue;
      const key = m.get("subPath");
      const path = m.get("mountPath");
      if (typeof key === "string" && typeof path === "string") found.push({ key, path });
    }
  }
  return found;
}

/** Removes the managed entries from a list, and the list itself when nothing else is left in it. */
function withoutManaged(parent: YAMLMap, field: string, managed: (item: unknown) => boolean): YAMLSeq | null {
  const list = parent.get(field, true);
  if (!isSeq(list)) return null;
  list.items = list.items.filter((item) => !managed(item));
  return list;
}

/**
 * Sets the files a component's workloads mount, replacing what stardust
 * mounted before; an empty list removes the volume. Workloads with no
 * container are skipped. Comments and the rest of each document stay.
 */
export function setFileMounts(
  text: string,
  input: { component: string; secretName: string; mounts: readonly FileMount[] },
): { text: string; workloads: number; changed: boolean } {
  const docs = parseAllDocuments(text);
  let workloads = 0;
  let changed = false;
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new Error(`cannot parse manifest: ${doc.errors[0]?.message}`);
    if (!WORKLOADS.has(String(doc.get("kind")))) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (!isMap(spec)) continue;
    const container = containerOf(spec, input.component);
    if (!container) continue;
    workloads++;
    const before = doc.toString();

    const isOurs = (item: unknown) => isMap(item) && item.get("name") === FILES_VOLUME;
    // A path the workload already mounts another volume on would make the pod invalid.
    const existing = container.get("volumeMounts", true);
    const taken = new Set(
      isSeq(existing)
        ? existing.items.filter((m) => isMap(m) && !isOurs(m)).map((m) => String((m as YAMLMap).get("mountPath")))
        : [],
    );
    const clash = input.mounts.find((m) => taken.has(m.path));
    if (clash)
      throw new Error(
        `${clash.path} is already a mount of another volume in ${String(doc.getIn(["metadata", "name"]))}`,
      );
    const volumes = withoutManaged(spec, "volumes", isOurs);
    const mounts = withoutManaged(container, "volumeMounts", isOurs);
    if (input.mounts.length > 0) {
      const volume = doc.createNode({
        name: FILES_VOLUME,
        secret: {
          secretName: input.secretName,
          // Only the keys mounted: a value not listed here never reaches the disk.
          items: [...new Set(input.mounts.map((m) => m.key))].sort().map((key) => ({ key, path: key })),
        },
      });
      if (volumes) volumes.items.push(volume);
      else spec.set("volumes", doc.createNode([volume.toJSON()]));
      const entries = input.mounts.map((m) =>
        doc.createNode({ name: FILES_VOLUME, mountPath: m.path, subPath: m.key, readOnly: true }),
      );
      if (mounts) mounts.items.push(...entries);
      else container.set("volumeMounts", doc.createNode(entries.map((e) => e.toJSON())));
    }
    if (volumes && volumes.items.length === 0) spec.delete("volumes");
    if (mounts && mounts.items.length === 0) container.delete("volumeMounts");
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
