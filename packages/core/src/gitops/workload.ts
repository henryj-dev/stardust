/**
 * How a component's pods run, set from its page instead of by hand: its own
 * service account (and whether the pod gets a token), HTTP probes, a
 * read-only root filesystem with the paths it may write to, the user and
 * group ids it runs as, and whether a Deployment rolls one pod at a time.
 *
 * Only what stardust manages is touched; the rest of each manifest (other
 * volumes, other fields, comments) stays as it is:
 *
 * - the service account is `<component>`, in `stardust-serviceaccount.yaml`
 *   next to the manifests and listed in the kustomization. One declared by
 *   hand in the directory under that name is used as it is.
 * - a writable path is an emptyDir volume named `stardust-writable-…`.
 * - "one at a time" is `RollingUpdate` with `maxSurge: 0, maxUnavailable: 1`.
 *   The strategy is never switched to `Recreate`: a live Deployment with
 *   RollingUpdate defaults refuses that change, and a GitOps controller that
 *   cannot apply one object stops applying the rest.
 */
import { createHash } from "node:crypto";
import { type Document, isMap, isSeq, parseAllDocuments, parse as parseYaml, stringify, type YAMLMap } from "yaml";
import { WorkloadEditError } from "../runtime/workloads.ts";
import { addResource, removeResource } from "./kustomization.ts";

/** The service account file stardust writes. */
export const SERVICE_ACCOUNT_FILE = "stardust-serviceaccount.yaml";
/** The ClusterRoleBindings of the component's service account (see gitops/cluster-roles). */
export const CLUSTER_ROLES_FILE = "stardust-cluster-roles.yaml";
/** Pod volumes stardust manages for writable paths start with this. */
export const WRITABLE_VOLUME_PREFIX = "stardust-writable-";
export const serviceAccountName = (component: string) => component;

export interface HttpProbe {
  /** The path asked for, starting with `/`. */
  path: string;
  port: number;
  /** Seconds between checks (default 10). */
  periodSeconds?: number;
  /** Failures in a row before the probe gives up (default 30 for startup, 3 otherwise). */
  failureThreshold?: number;
}

export const PROBES = ["startup", "readiness", "liveness"] as const;
export type ProbeKind = (typeof PROBES)[number];
const PROBE_FIELD: Record<ProbeKind, string> = {
  startup: "startupProbe",
  readiness: "readinessProbe",
  liveness: "livenessProbe",
};
const DEFAULT_FAILURES: Record<ProbeKind, number> = { startup: 30, readiness: 3, liveness: 3 };

export interface WorkloadSettings {
  /** The pod runs as its own service account `<component>` with a token mounted; off, it gets no token. */
  serviceAccount: boolean;
  probes: Record<ProbeKind, HttpProbe | null>;
  readOnlyRootFilesystem: boolean;
  /** Absolute paths the container may write to: an emptyDir each. */
  writablePaths: string[];
  runAsUser: number | null;
  runAsGroup: number | null;
  fsGroup: number | null;
  /** A Deployment rolls one pod at a time, the old one stopped first. */
  oneAtATime: boolean;
}

/** What a change sets; a field left out is left as it is. */
export type WorkloadChange = Partial<Omit<WorkloadSettings, "probes">> & {
  probes?: Partial<Record<ProbeKind, HttpProbe | null>>;
};

export interface WorkloadView extends WorkloadSettings {
  /** Whether the pod gets a service account token (Kubernetes mounts one unless told not to). */
  tokenMounted: boolean;
  /** Probes set by hand in a form stardust does not edit (exec, TCP, a named port): kept unless replaced. */
  otherProbes: ProbeKind[];
  /** The Deployment uses Recreate, set by hand: kept as it is. */
  recreate: boolean;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const HTTP_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;
const MAX_ID = 2147483647;

const isAbsolutePath = (p: unknown): p is string =>
  typeof p === "string" &&
  p.startsWith("/") &&
  p !== "/" &&
  p.length <= 1024 &&
  p
    .slice(1)
    .split("/")
    .every((s) => SEGMENT.test(s) && s !== "." && s !== "..");

function checkProbe(kind: ProbeKind, p: unknown): HttpProbe | null {
  if (p === null) return null;
  const { path, port, periodSeconds, failureThreshold, ...rest } = (p ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || Object.keys(rest).length > 0) {
    throw new WorkloadEditError(`probes.${kind} must be null or { path, port, periodSeconds?, failureThreshold? }`);
  }
  if (typeof path !== "string" || path.length > 1024 || !HTTP_PATH.test(path)) {
    throw new WorkloadEditError(`probes.${kind}.path must be a path such as /healthz`);
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new WorkloadEditError(`probes.${kind}.port must be 1-65535`);
  }
  const out: HttpProbe = { path, port: port as number };
  if (periodSeconds !== undefined) {
    if (!Number.isInteger(periodSeconds) || (periodSeconds as number) < 1 || (periodSeconds as number) > 3600)
      throw new WorkloadEditError(`probes.${kind}.periodSeconds must be 1-3600`);
    out.periodSeconds = periodSeconds as number;
  }
  if (failureThreshold !== undefined) {
    if (!Number.isInteger(failureThreshold) || (failureThreshold as number) < 1 || (failureThreshold as number) > 1000)
      throw new WorkloadEditError(`probes.${kind}.failureThreshold must be 1-1000`);
    out.failureThreshold = failureThreshold as number;
  }
  return out;
}

function checkId(field: string, v: unknown, min: number): number | null {
  if (v === null) return null;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > MAX_ID) {
    throw new WorkloadEditError(
      min === 1
        ? `${field} must be a user id from 1 (0 is root, which the restricted Pod Security standard refuses) or null`
        : `${field} must be a group id or null`,
    );
  }
  return v as number;
}

/** Checks a change asked for; the reasons name fields, never values from secrets. */
export function checkWorkloadChange(input: unknown): WorkloadChange {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new WorkloadEditError("the settings must be a mapping");
  const b = input as Record<string, unknown>;
  const known = new Set([
    "serviceAccount",
    "probes",
    "readOnlyRootFilesystem",
    "writablePaths",
    "runAsUser",
    "runAsGroup",
    "fsGroup",
    "oneAtATime",
  ]);
  for (const k of Object.keys(b)) if (!known.has(k)) throw new WorkloadEditError(`unknown field ${k}`);
  const out: WorkloadChange = {};
  for (const k of ["serviceAccount", "readOnlyRootFilesystem", "oneAtATime"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") throw new WorkloadEditError(`${k} must be true or false`);
    out[k] = b[k] as boolean;
  }
  if (b.probes !== undefined) {
    if (typeof b.probes !== "object" || b.probes === null || Array.isArray(b.probes))
      throw new WorkloadEditError("probes must be a mapping of startup, readiness and liveness");
    const probes: Partial<Record<ProbeKind, HttpProbe | null>> = {};
    for (const [k, v] of Object.entries(b.probes)) {
      if (!(PROBES as readonly string[]).includes(k)) throw new WorkloadEditError(`unknown probe ${k}`);
      probes[k as ProbeKind] = checkProbe(k as ProbeKind, v);
    }
    out.probes = probes;
  }
  if (b.writablePaths !== undefined) {
    if (!Array.isArray(b.writablePaths)) throw new WorkloadEditError("writablePaths must be a list of paths");
    if (b.writablePaths.length > 16) throw new WorkloadEditError("at most 16 writable paths");
    const seen = new Set<string>();
    out.writablePaths = b.writablePaths.map((p, i) => {
      if (!isAbsolutePath(p))
        throw new WorkloadEditError(`writablePaths.${i} must be a plain absolute path, without . or .. or empty parts`);
      if (seen.has(p)) throw new WorkloadEditError(`${p} is listed twice`);
      seen.add(p);
      return p;
    });
  }
  if (b.runAsUser !== undefined) out.runAsUser = checkId("runAsUser", b.runAsUser, 1);
  if (b.runAsGroup !== undefined) out.runAsGroup = checkId("runAsGroup", b.runAsGroup, 0);
  if (b.fsGroup !== undefined) out.fsGroup = checkId("fsGroup", b.fsGroup, 0);
  return out;
}

/** The pod volume for a writable path: readable, and unique within the list. */
export function writableVolumeName(path: string, taken: ReadonlySet<string> = new Set()): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const plain = `${WRITABLE_VOLUME_PREFIX}${slug || "root"}`;
  if (plain.length <= 63 && !taken.has(plain)) return plain;
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `${plain.slice(0, 63 - 9).replace(/-+$/, "")}-${hash}`;
}

type Container = YAMLMap<unknown, unknown>;

function containerOf(spec: YAMLMap, component: string): Container | null {
  const containers = spec.get("containers", true);
  if (!isSeq(containers)) return null;
  const maps = containers.items.filter(isMap) as Container[];
  return maps.find((c) => c.get("name") === component) ?? maps[0] ?? null;
}

function readProbe(container: Container, kind: ProbeKind): HttpProbe | "other" | null {
  const probe = container.get(PROBE_FIELD[kind], true);
  if (!probe) return null;
  const p = (isMap(probe) ? probe.toJSON() : null) as {
    httpGet?: { path?: unknown; port?: unknown; scheme?: unknown; host?: unknown; httpHeaders?: unknown };
    periodSeconds?: unknown;
    failureThreshold?: unknown;
  } | null;
  const get = p?.httpGet;
  if (
    !get ||
    typeof get.path !== "string" ||
    typeof get.port !== "number" ||
    (get.scheme !== undefined && get.scheme !== "HTTP") ||
    get.host !== undefined ||
    get.httpHeaders !== undefined
  )
    return "other";
  return {
    path: get.path,
    port: get.port,
    ...(typeof p?.periodSeconds === "number" ? { periodSeconds: p.periodSeconds } : {}),
    ...(typeof p?.failureThreshold === "number" ? { failureThreshold: p.failureThreshold } : {}),
  };
}

const probeNode = (kind: ProbeKind, p: HttpProbe) => ({
  httpGet: { path: p.path, port: p.port },
  periodSeconds: p.periodSeconds ?? 10,
  failureThreshold: p.failureThreshold ?? DEFAULT_FAILURES[kind],
});

function workloadDocs(text: string) {
  const docs = parseAllDocuments(text);
  const found: Array<{ doc: Document; kind: string; spec: YAMLMap; container: Container }> = [];
  for (const doc of docs) {
    if (doc.errors.length > 0) throw new WorkloadEditError(`cannot parse manifest: ${doc.errors[0]?.message}`);
    const kind = String(doc.get("kind"));
    if (!WORKLOADS.has(kind)) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (!isMap(spec)) continue;
    const container = containerOf(spec, "");
    if (container) found.push({ doc, kind, spec, container });
  }
  return { docs, found };
}

const writableMounts = (container: Container): Array<{ name: string; path: string }> => {
  const mounts = container.get("volumeMounts", true);
  if (!isSeq(mounts)) return [];
  return mounts.items.flatMap((m) => {
    if (!isMap(m)) return [];
    const name = m.get("name");
    const path = m.get("mountPath");
    return typeof name === "string" && name.startsWith(WRITABLE_VOLUME_PREFIX) && typeof path === "string"
      ? [{ name, path }]
      : [];
  });
};

const strategyOf = (doc: Document) => ({
  type: doc.getIn(["spec", "strategy", "type"]),
  oneAtATime:
    doc.getIn(["spec", "strategy", "rollingUpdate", "maxSurge"]) === 0 &&
    doc.getIn(["spec", "strategy", "rollingUpdate", "maxUnavailable"]) === 1,
});

/** The settings as the first workload of a manifest has them, or null when it runs no container. */
export function readWorkloadSettings(text: string, component: string): WorkloadView | null {
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text);
  } catch {
    return null;
  }
  for (const doc of docs) {
    if (doc.errors.length > 0 || !WORKLOADS.has(String(doc.get("kind")))) continue;
    const spec = doc.getIn(["spec", "template", "spec"], true);
    if (!isMap(spec)) continue;
    const container = containerOf(spec, component);
    if (!container) continue;
    const probes = {} as Record<ProbeKind, HttpProbe | null>;
    const otherProbes: ProbeKind[] = [];
    for (const kind of PROBES) {
      const p = readProbe(container, kind);
      if (p === "other") otherProbes.push(kind);
      probes[kind] = p === "other" ? null : p;
    }
    const num = (path: unknown[]) => {
      const v = doc.getIn(path);
      return typeof v === "number" ? v : null;
    };
    const pod = ["spec", "template", "spec", "securityContext"];
    const strategy = strategyOf(doc);
    const deployment = doc.get("kind") === "Deployment";
    return {
      serviceAccount: spec.get("serviceAccountName") === serviceAccountName(component),
      tokenMounted: spec.get("automountServiceAccountToken") !== false,
      probes,
      otherProbes,
      readOnlyRootFilesystem: container.getIn(["securityContext", "readOnlyRootFilesystem"]) === true,
      writablePaths: writableMounts(container).map((m) => m.path),
      runAsUser: num([...pod, "runAsUser"]),
      runAsGroup: num([...pod, "runAsGroup"]),
      fsGroup: num([...pod, "fsGroup"]),
      oneAtATime: deployment && (strategy.oneAtATime || strategy.type === "Recreate"),
      recreate: deployment && strategy.type === "Recreate",
    };
  }
  return null;
}

/** Sets a value, or deletes it (and the mapping it leaves empty) for null. */
function setOrDelete(doc: Document, path: unknown[], value: unknown): void {
  if (value === null) {
    if (!doc.hasIn(path)) return;
    doc.deleteIn(path);
    for (let i = path.length - 1; i > 0; i--) {
      const parent = doc.getIn(path.slice(0, i), true);
      if (isMap(parent) && parent.items.length === 0) doc.deleteIn(path.slice(0, i));
      else break;
    }
    return;
  }
  if (doc.getIn(path) !== value) doc.setIn(path, value);
}

/**
 * Applies a change to every workload in a manifest, leaving what it does not
 * name as it is. The service account file itself is the planner's job.
 */
export function setWorkloadSettings(
  text: string,
  input: { component: string; change: WorkloadChange },
): { text: string; workloads: number; changed: boolean } {
  const { docs, found } = workloadDocs(text);
  const c = input.change;
  let changed = false;
  for (const { doc, kind, spec } of found) {
    const container = containerOf(spec, input.component) as Container;
    const before = doc.toString();
    const name = String(doc.getIn(["metadata", "name"]));
    const podSpec: unknown[] = ["spec", "template", "spec"];
    const list = spec.get("containers", true);
    const cIndex = isSeq(list) ? list.items.indexOf(container) : 0;
    const cPath: unknown[] = [...podSpec, "containers", cIndex];

    if (c.serviceAccount !== undefined) {
      const sa = serviceAccountName(input.component);
      if (c.serviceAccount) {
        setOrDelete(doc, [...podSpec, "serviceAccountName"], sa);
        setOrDelete(doc, [...podSpec, "automountServiceAccountToken"], true);
      } else {
        if (spec.get("serviceAccountName") === sa) spec.delete("serviceAccountName");
        setOrDelete(doc, [...podSpec, "automountServiceAccountToken"], false);
      }
    }
    for (const [k, p] of Object.entries(c.probes ?? {}) as Array<[ProbeKind, HttpProbe | null]>) {
      const field = PROBE_FIELD[k];
      if (p === null) {
        if (container.has(field)) container.delete(field);
        continue;
      }
      const want = probeNode(k, p);
      const have = container.get(field, true);
      if (!(isMap(have) && JSON.stringify(have.toJSON()) === JSON.stringify(want)))
        container.set(field, doc.createNode(want));
    }
    if (c.readOnlyRootFilesystem !== undefined) {
      setOrDelete(doc, [...cPath, "securityContext", "readOnlyRootFilesystem"], c.readOnlyRootFilesystem || null);
    }
    if (c.writablePaths !== undefined) {
      const isOurs = (item: unknown) => isMap(item) && String(item.get("name")).startsWith(WRITABLE_VOLUME_PREFIX);
      const mounts = container.get("volumeMounts", true);
      const taken = new Set(
        isSeq(mounts)
          ? mounts.items.filter((m) => isMap(m) && !isOurs(m)).map((m) => String((m as YAMLMap).get("mountPath")))
          : [],
      );
      const clash = c.writablePaths.find((p) => taken.has(p));
      if (clash) throw new WorkloadEditError(`${clash} is already a mount of another volume in ${name}`);
      const have = writableMounts(container);
      const same =
        JSON.stringify(have.map((m) => m.path).sort()) === JSON.stringify([...c.writablePaths].sort()) &&
        have.every((m) => {
          const vols = spec.get("volumes", true);
          return (
            isSeq(vols) &&
            vols.items.some((v) => isMap(v) && v.get("name") === m.name && isMap(v.get("emptyDir", true)))
          );
        });
      if (!same) {
        const volumes = spec.get("volumes", true);
        if (isSeq(volumes)) volumes.items = volumes.items.filter((v) => !isOurs(v));
        if (isSeq(mounts)) mounts.items = mounts.items.filter((m) => !isOurs(m));
        const used = new Set<string>(
          isSeq(volumes) ? volumes.items.flatMap((v) => (isMap(v) ? [String(v.get("name"))] : [])) : [],
        );
        const entries = c.writablePaths.map((path) => {
          const vol = writableVolumeName(path, used);
          used.add(vol);
          return { vol, path };
        });
        if (entries.length > 0) {
          const vs = entries.map((e) => doc.createNode({ name: e.vol, emptyDir: {} }));
          if (isSeq(volumes)) volumes.items.push(...vs);
          else spec.set("volumes", doc.createNode(vs.map((v) => v.toJSON())));
          const ms = entries.map((e) => doc.createNode({ name: e.vol, mountPath: e.path }));
          if (isSeq(mounts)) mounts.items.push(...ms);
          else container.set("volumeMounts", doc.createNode(ms.map((m) => m.toJSON())));
        }
        const v2 = spec.get("volumes", true);
        if (isSeq(v2) && v2.items.length === 0) spec.delete("volumes");
        const m2 = container.get("volumeMounts", true);
        if (isSeq(m2) && m2.items.length === 0) container.delete("volumeMounts");
      }
    }
    for (const k of ["runAsUser", "runAsGroup", "fsGroup"] as const) {
      if (c[k] === undefined) continue;
      setOrDelete(doc, [...podSpec, "securityContext", k], c[k]);
    }
    if (c.oneAtATime !== undefined && kind === "Deployment") {
      const s = strategyOf(doc);
      if (c.oneAtATime && s.type !== "Recreate" && !(s.oneAtATime && s.type === "RollingUpdate")) {
        doc.setIn(
          ["spec", "strategy"],
          doc.createNode({ type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } }),
        );
      } else if (!c.oneAtATime && s.type !== "Recreate" && s.oneAtATime) {
        const vols = spec.get("volumes", true);
        const claims = isSeq(vols) && vols.items.some((v) => isMap(v) && isMap(v.get("persistentVolumeClaim", true)));
        if (claims) {
          throw new WorkloadEditError(
            `${name} mounts a claim, which one pod writes at a time: it keeps rolling one pod at a time`,
          );
        }
        doc.deleteIn(["spec", "strategy"]);
      }
    }
    if (doc.toString() !== before) changed = true;
  }
  if (!changed) return { text, workloads: found.length, changed };
  const out = docs
    .map((d, i) => {
      const s = d.toString();
      return i > 0 && !s.startsWith("---") ? `---\n${s}` : s;
    })
    .join("");
  return { text: out, workloads: found.length, changed };
}

export function serviceAccountDocument(input: { component: string; namespace: string }): string {
  return `# The component's own service account (stardust's Workload settings).
${stringify({
  apiVersion: "v1",
  kind: "ServiceAccount",
  metadata: { name: serviceAccountName(input.component), namespace: input.namespace },
})}`;
}

const KUSTOMIZATIONS = ["kustomization.yaml", "kustomization.yml"];
const MANIFEST = /\.ya?ml$/;

/** Whether a file is stardust's own (env, pull Secret, bindings, …): it runs nothing and is not edited here. */
const isWorkloadFile = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return MANIFEST.test(base) && !base.startsWith("env.") && !KUSTOMIZATIONS.includes(base) && !base.includes(".enc.");
};

/** The one namespace a directory's workloads run in, or why there is none. */
export function workloadNamespace(files: ReadonlyMap<string, string>, dir: string): string | { error: string } {
  let fallback: string | null = null;
  for (const k of KUSTOMIZATIONS) {
    const text = files.get(`${dir}/${k}`);
    if (!text) continue;
    const doc = parseYaml(text) as { namespace?: unknown } | null;
    if (typeof doc?.namespace === "string") fallback = doc.namespace;
  }
  const namespaces = new Set<string | null>();
  for (const [path, text] of files) {
    if (!isWorkloadFile(path)) continue;
    for (const doc of parseAllDocuments(text)) {
      if (doc.errors.length > 0 || !WORKLOADS.has(String(doc.get("kind")))) continue;
      const ns = doc.getIn(["metadata", "namespace"]);
      namespaces.add(typeof ns === "string" ? ns : fallback);
    }
  }
  if (namespaces.size === 0) return { error: `${dir} has no Deployment, StatefulSet or DaemonSet` };
  if (namespaces.has(null)) return { error: `the manifests in ${dir} name no namespace` };
  if (namespaces.size > 1) return { error: `the workloads in ${dir} run in more than one namespace` };
  return [...namespaces][0] as string;
}

/** Whether a manifest other than stardust's own declares a ServiceAccount of this name. */
function declaresServiceAccount(files: ReadonlyMap<string, string>, dir: string, name: string): boolean {
  for (const [path, text] of files) {
    if (path === `${dir}/${SERVICE_ACCOUNT_FILE}` || !MANIFEST.test(path)) continue;
    for (const doc of parseAllDocuments(text)) {
      if (doc.errors.length === 0 && doc.get("kind") === "ServiceAccount" && doc.getIn(["metadata", "name"]) === name)
        return true;
    }
  }
  return false;
}

/** The workload settings of a directory's manifests (path → text), as the first workload has them. */
export function readDirectoryWorkload(
  files: ReadonlyMap<string, string>,
  component: string,
): { settings: WorkloadView | null; workloads: number } {
  let settings: WorkloadView | null = null;
  let workloads = 0;
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isWorkloadFile(path)) continue;
    const s = readWorkloadSettings(text, component);
    if (s) {
      workloads++;
      settings ??= s;
    }
  }
  return { settings, workloads };
}

/**
 * The changes (path → new text, or null to delete) that give a directory's
 * workloads these settings: the workload manifests, the service account
 * file and the kustomization listing it, for one commit.
 */
export function planWorkload(
  files: ReadonlyMap<string, string>,
  input: { dir: string; component: string; change: WorkloadChange },
): Map<string, string | null> {
  const dir = input.dir.replace(/\/+$/, "");
  const out = new Map<string, string | null>();
  let workloads = 0;
  for (const [path, text] of files) {
    if (!isWorkloadFile(path) || !path.startsWith(`${dir}/`)) continue;
    let edited: ReturnType<typeof setWorkloadSettings>;
    try {
      edited = setWorkloadSettings(text, { component: input.component, change: input.change });
    } catch (err) {
      throw new WorkloadEditError(`${path}: ${(err as Error).message}`);
    }
    workloads += edited.workloads;
    if (edited.changed) out.set(path, edited.text);
  }
  if (workloads === 0) throw new WorkloadEditError(`${dir} has no Deployment, StatefulSet or DaemonSet`);

  if (input.change.serviceAccount === false && files.has(`${dir}/${CLUSTER_ROLES_FILE}`)) {
    throw new WorkloadEditError(
      `${input.component}'s service account has cluster roles bound: remove them (Cluster roles) before turning it off`,
    );
  }
  if (input.change.serviceAccount !== undefined) {
    const path = `${dir}/${SERVICE_ACCOUNT_FILE}`;
    const kustomization = KUSTOMIZATIONS.map((k) => `${dir}/${k}`).find((p) => files.has(p));
    const byHand = declaresServiceAccount(files, dir, serviceAccountName(input.component));
    const want = input.change.serviceAccount && !byHand;
    if (want) {
      const ns = workloadNamespace(files, dir);
      if (typeof ns !== "string") throw new WorkloadEditError(ns.error);
      const text = serviceAccountDocument({ component: input.component, namespace: ns });
      if (files.get(path) !== text) out.set(path, text);
    } else if (files.has(path)) {
      out.set(path, null);
    }
    if (kustomization) {
      const listing = files.get(kustomization) ?? "";
      let next: string;
      try {
        next = want ? addResource(listing, SERVICE_ACCOUNT_FILE) : removeResource(listing, SERVICE_ACCOUNT_FILE);
      } catch (err) {
        throw new WorkloadEditError(`${kustomization}: ${(err as Error).message}`);
      }
      if (next !== listing) out.set(kustomization, next);
    } else if (want) {
      throw new WorkloadEditError(`${dir} has no kustomization.yaml to list ${SERVICE_ACCOUNT_FILE} in`);
    }
  }
  return out;
}
