/**
 * Secret files a component reads that are not environment variables: a key
 * of 32 random bytes, a binary keystore. Each set is a Secret of its own,
 * `<component>-files-<name>`, sealed in `secret-files-<name>.secret.enc.yaml`
 * next to the manifests and listed in the kustomization; it is never in
 * envFrom, so its values (which may be binary) do not become variables.
 *
 * A set is mounted read-only at `/run/secrets/<name>/`, one file per key,
 * mode 0440: owned by root and the pod's fsGroup, so the pod needs one.
 * stardust can generate a value (random bytes; it never passes through a
 * person) or take one uploaded; no value is ever shown or logged, only key
 * names, which SOPS leaves in clear.
 */
import { isMap, isSeq, parse, parseAllDocuments, stringify, type YAMLMap } from "yaml";
import { WorkloadEditError } from "../runtime/workloads.ts";

export const SECRET_SET_VOLUME_PREFIX = "stardust-secret-";
export const SECRET_FILES_ROOT = "/run/secrets";
/** 0440: the owner (root) and the pod's fsGroup read; nobody writes. */
export const SECRET_FILE_MODE = 0o440;

const SET = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/;
const KEY = /^[-._a-zA-Z0-9]{1,253}$/;
export const isSecretSetName = (v: unknown): v is string => typeof v === "string" && SET.test(v);
export const isSecretKey = (v: unknown): v is string => typeof v === "string" && KEY.test(v) && v !== "." && v !== "..";

export const secretSetFile = (name: string) => `secret-files-${name}.secret.enc.yaml`;
export const secretSetSecretName = (component: string, name: string) => `${component}-files-${name}`;
export const secretSetVolume = (name: string) => `${SECRET_SET_VOLUME_PREFIX}${name}`;
export const secretSetPath = (name: string) => `${SECRET_FILES_ROOT}/${name}`;
const FILE = /(^|\/)secret-files-([a-z0-9-]+)\.secret\.enc\.yaml$/;
/** The set a file holds, from its name, or null when it is not one. */
export const secretSetOf = (path: string) => FILE.exec(path)?.[2] ?? null;

/** The plain Secret, values base64 under `data` so bytes stay bytes; the caller seals it. */
export function secretSetDocument(input: {
  component: string;
  namespace: string;
  name: string;
  data: Readonly<Record<string, Buffer>>;
}): string {
  const data = Object.fromEntries(
    Object.keys(input.data)
      .sort()
      .map((k) => [k, (input.data[k] as Buffer).toString("base64")]),
  );
  return stringify(
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: secretSetSecretName(input.component, input.name),
        namespace: input.namespace,
        labels: { "app.kubernetes.io/part-of": input.component, "app.kubernetes.io/managed-by": "stardust" },
      },
      type: "Opaque",
      data,
    },
    { lineWidth: 0 },
  );
}

/** The key names of a sealed (or plain) Secret, without decrypting it: SOPS leaves keys in clear. */
export function secretKeysOf(text: string): string[] {
  const doc = parse(text) as { data?: Record<string, unknown>; stringData?: Record<string, unknown> } | null;
  return [...new Set([...Object.keys(doc?.data ?? {}), ...Object.keys(doc?.stringData ?? {})])].sort();
}

/** The values of a decrypted Secret, as bytes. */
export function secretValuesOf(plain: string): Record<string, Buffer> {
  const doc = parse(plain) as { data?: Record<string, unknown>; stringData?: Record<string, unknown> } | null;
  const out: Record<string, Buffer> = {};
  for (const [k, v] of Object.entries(doc?.stringData ?? {})) out[k] = Buffer.from(String(v), "utf8");
  for (const [k, v] of Object.entries(doc?.data ?? {})) out[k] = Buffer.from(String(v), "base64");
  return out;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
type Container = YAMLMap<unknown, unknown>;

function containerOf(spec: YAMLMap, component: string): Container | null {
  const containers = spec.get("containers", true);
  if (!isSeq(containers)) return null;
  const maps = containers.items.filter(isMap) as Container[];
  return maps.find((c) => c.get("name") === component) ?? maps[0] ?? null;
}

/** The sets a manifest's workloads mount, by name. */
export function readSecretMounts(text: string, component: string): string[] {
  const names = new Set<string>();
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0 || !WORKLOADS.has(String(doc.get("kind")))) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (!isMap(spec)) continue;
    const mounts = containerOf(spec, component)?.get("volumeMounts", true);
    if (!isSeq(mounts)) continue;
    for (const m of mounts.items) {
      const n = isMap(m) ? m.get("name") : null;
      if (typeof n === "string" && n.startsWith(SECRET_SET_VOLUME_PREFIX))
        names.add(n.slice(SECRET_SET_VOLUME_PREFIX.length));
    }
  }
  return [...names].sort();
}

/**
 * Mounts exactly these sets in every workload of a manifest, replacing what
 * stardust mounted before; other volumes stay. The pod must have an fsGroup
 * (the files are 0440), unless no set is mounted.
 */
export function setSecretMounts(
  text: string,
  input: { component: string; sets: readonly string[] },
): { text: string; workloads: number; changed: boolean } {
  const docs = parseAllDocuments(text);
  let workloads = 0;
  let changed = false;
  const isOurs = (item: unknown) => isMap(item) && String(item.get("name")).startsWith(SECRET_SET_VOLUME_PREFIX);
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new WorkloadEditError(`cannot parse manifest: ${doc.errors[0]?.message}`);
    if (!WORKLOADS.has(String(doc.get("kind")))) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (!isMap(spec)) continue;
    const container = containerOf(spec, input.component);
    if (!container) continue;
    workloads++;
    const name = String(doc.getIn(["metadata", "name"]));
    const sets = [...new Set(input.sets)].sort();
    if (sets.length > 0 && typeof doc.getIn(["spec", "template", "spec", "securityContext", "fsGroup"]) !== "number") {
      throw new WorkloadEditError(
        `${name} has no fsGroup: secret files are readable by their group only (0440). Set fsGroup in the Workload section first`,
      );
    }
    const mounts = container.get("volumeMounts", true);
    const taken = new Set(
      isSeq(mounts)
        ? mounts.items.filter((m) => isMap(m) && !isOurs(m)).map((m) => String((m as YAMLMap).get("mountPath")))
        : [],
    );
    for (const s of sets) {
      const path = secretSetPath(s);
      for (const t of taken)
        if (t === path || t.startsWith(`${path}/`) || path.startsWith(`${t}/`))
          throw new WorkloadEditError(`${path} overlaps ${t}, a mount of another volume in ${name}`);
    }
    if (JSON.stringify(readSecretMounts(doc.toString(), input.component)) === JSON.stringify(sets)) {
      // Mounted as asked already: leave the entries as they are written.
      const vols = spec.get("volumes", true);
      const same =
        isSeq(vols) &&
        sets.every((s) =>
          vols.items.some(
            (v) =>
              isMap(v) &&
              v.get("name") === secretSetVolume(s) &&
              v.getIn(["secret", "secretName"]) === secretSetSecretName(input.component, s) &&
              v.getIn(["secret", "defaultMode"]) === SECRET_FILE_MODE,
          ),
        );
      if (same || sets.length === 0) continue;
    }
    const before = doc.toString();
    const volumes = spec.get("volumes", true);
    if (isSeq(volumes)) volumes.items = volumes.items.filter((v) => !isOurs(v));
    if (isSeq(mounts)) mounts.items = mounts.items.filter((m) => !isOurs(m));
    if (sets.length > 0) {
      const vs = sets.map((s) =>
        doc.createNode({
          name: secretSetVolume(s),
          secret: { secretName: secretSetSecretName(input.component, s), defaultMode: SECRET_FILE_MODE },
        }),
      );
      if (isSeq(volumes)) volumes.items.push(...vs);
      else spec.set("volumes", doc.createNode(vs.map((v) => v.toJSON())));
      const ms = sets.map((s) =>
        doc.createNode({ name: secretSetVolume(s), mountPath: secretSetPath(s), readOnly: true }),
      );
      if (isSeq(mounts)) mounts.items.push(...ms);
      else container.set("volumeMounts", doc.createNode(ms.map((m) => m.toJSON())));
    }
    const v2 = spec.get("volumes", true);
    if (isSeq(v2) && v2.items.length === 0) spec.delete("volumes");
    const m2 = container.get("volumeMounts", true);
    if (isSeq(m2) && m2.items.length === 0) container.delete("volumeMounts");
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
