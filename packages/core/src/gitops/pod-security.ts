/**
 * Whether a manifest's workloads meet the restricted Pod Security standard
 * (https://kubernetes.io/docs/concepts/security/pod-security-standards/),
 * read from the manifest as committed. A namespace that enforces it refuses
 * pods that do not, and the workload then never starts; this says why before
 * anything is applied. It checks what a manifest can say: an image whose
 * USER is a name cannot be checked here, which is why the numeric user id
 * belongs in the manifest.
 */
import { parseAllDocuments } from "yaml";

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod", "ReplicaSet"]);
const VOLUMES = new Set([
  "configMap",
  "csi",
  "downwardAPI",
  "emptyDir",
  "ephemeral",
  "persistentVolumeClaim",
  "projected",
  "secret",
]);

interface SecurityContext {
  privileged?: unknown;
  allowPrivilegeEscalation?: unknown;
  runAsNonRoot?: unknown;
  runAsUser?: unknown;
  capabilities?: { add?: unknown; drop?: unknown };
  seccompProfile?: { type?: unknown };
  procMount?: unknown;
}
interface ContainerSpec {
  name?: unknown;
  securityContext?: SecurityContext;
  ports?: Array<{ hostPort?: unknown }>;
}
interface PodSpec {
  hostNetwork?: unknown;
  hostPID?: unknown;
  hostIPC?: unknown;
  securityContext?: SecurityContext;
  containers?: ContainerSpec[];
  initContainers?: ContainerSpec[];
  volumes?: Array<Record<string, unknown>>;
}

function podSpecOf(o: Record<string, unknown>): PodSpec | null {
  const kind = o.kind;
  const spec = o.spec as Record<string, unknown> | undefined;
  if (kind === "Pod") return (spec as PodSpec) ?? null;
  if (kind === "CronJob") {
    const job = (spec?.jobTemplate as { spec?: { template?: { spec?: PodSpec } } } | undefined)?.spec;
    return job?.template?.spec ?? null;
  }
  return (spec?.template as { spec?: PodSpec } | undefined)?.spec ?? null;
}

/** Why the pods of one object would be refused under restricted, or nothing. */
export function restrictedPodProblems(pod: PodSpec, what: string): string[] {
  const problems: string[] = [];
  for (const k of ["hostNetwork", "hostPID", "hostIPC"] as const)
    if (pod[k] === true) problems.push(`${what}: ${k} is not allowed`);
  for (const v of pod.volumes ?? []) {
    const type = Object.keys(v).find((k) => k !== "name");
    if (type && !VOLUMES.has(type)) problems.push(`${what}: volume ${String(v.name)} is a ${type} volume`);
  }
  const podSc = pod.securityContext ?? {};
  if (podSc.runAsUser === 0) problems.push(`${what}: the pod runs as user 0 (root)`);
  const containers = [...(pod.containers ?? []), ...(pod.initContainers ?? [])];
  if (containers.length === 0) problems.push(`${what}: no containers`);
  for (const c of containers) {
    const sc = c.securityContext ?? {};
    const who = `${what} container ${String(c.name)}`;
    if (sc.privileged === true) problems.push(`${who}: privileged`);
    if (sc.allowPrivilegeEscalation !== false) problems.push(`${who}: allowPrivilegeEscalation must be false`);
    const nonRoot = sc.runAsNonRoot ?? podSc.runAsNonRoot;
    if (nonRoot !== true) problems.push(`${who}: runAsNonRoot must be true`);
    if (sc.runAsUser === 0) problems.push(`${who}: runs as user 0 (root)`);
    const drop = Array.isArray(sc.capabilities?.drop) ? sc.capabilities.drop : [];
    if (!drop.includes("ALL")) problems.push(`${who}: capabilities must drop ALL`);
    const add = Array.isArray(sc.capabilities?.add) ? sc.capabilities.add : [];
    for (const a of add) if (a !== "NET_BIND_SERVICE") problems.push(`${who}: adds the capability ${String(a)}`);
    const seccomp = sc.seccompProfile?.type ?? podSc.seccompProfile?.type;
    if (seccomp !== "RuntimeDefault" && seccomp !== "Localhost")
      problems.push(`${who}: seccompProfile must be RuntimeDefault or Localhost`);
    if (sc.procMount !== undefined && sc.procMount !== "Default") problems.push(`${who}: procMount must be Default`);
    for (const p of c.ports ?? [])
      if (p.hostPort !== undefined && p.hostPort !== 0) problems.push(`${who}: uses a host port`);
  }
  return problems;
}

/** Why the workloads in a manifest would be refused by a namespace enforcing restricted, or nothing. */
export function restrictedProblems(text: string): string[] {
  const problems: string[] = [];
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0) continue;
    const o = doc.toJS() as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || !WORKLOADS.has(String(o.kind))) continue;
    const pod = podSpecOf(o);
    const what = `${String(o.kind)} ${String((o.metadata as { name?: unknown } | undefined)?.name)}`;
    if (!pod) {
      problems.push(`${what}: no pod template`);
      continue;
    }
    problems.push(...restrictedPodProblems(pod, what));
  }
  return problems;
}
