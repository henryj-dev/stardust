/**
 * What runs now: a workload's status, its pods and recent events, read from
 * the Kubernetes API. Read-only.
 */
import type { KubeClient, Workload } from "@stardust/core";

export interface PodView {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  node: string | null;
  startedAt: string | null;
  containers: Array<{ name: string; ready: boolean; restarts: number; state: string; reason: string | null }>;
}

export interface EventView {
  type: string;
  reason: string;
  message: string;
  object: string;
  at: string | null;
  count: number;
}

export interface WorkloadView {
  kind: string;
  name: string;
  namespace: string;
  desired: number | null;
  ready: number;
  updated: number;
  available: number;
  pods: PodView[];
  events: EventView[];
}

const PLURAL: Record<string, string> = {
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
};

async function getJson<T>(kube: KubeClient, path: string): Promise<T | null> {
  const res = await kube.request("GET", path);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300)
    throw new Error(`kubernetes API GET ${path.split("?")[0]} returned ${res.status}`);
  return JSON.parse(res.body) as T;
}

interface Pod {
  metadata?: { name?: string; creationTimestamp?: string };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    startTime?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: Record<string, { reason?: string }>;
    }>;
  };
}

interface KubeEvent {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject?: { kind?: string; name?: string };
}

export async function readWorkload(kube: KubeClient, w: Workload, namespace: string): Promise<WorkloadView> {
  const ns = encodeURIComponent(namespace);
  const live = await getJson<{
    spec?: { replicas?: number };
    status?: Record<string, number>;
  }>(kube, `/apis/apps/v1/namespaces/${ns}/${PLURAL[w.kind]}/${encodeURIComponent(w.name)}`);
  const selector = Object.entries(w.selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const pods = selector
    ? ((
        await getJson<{ items?: Pod[] }>(
          kube,
          `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(selector)}`,
        )
      )?.items ?? [])
    : [];
  const podNames = new Set(pods.map((p) => p.metadata?.name).filter((n): n is string => !!n));
  // Events of the workload, its ReplicaSets (named after it) and its pods.
  const events = (
    (await getJson<{ items?: KubeEvent[] }>(kube, `/api/v1/namespaces/${ns}/events?limit=500`))?.items ?? []
  )
    .filter((e) => {
      const name = e.involvedObject?.name ?? "";
      return (
        name === w.name ||
        podNames.has(name) ||
        (e.involvedObject?.kind === "ReplicaSet" && name.startsWith(`${w.name}-`))
      );
    })
    .map((e) => ({
      type: e.type ?? "Normal",
      reason: e.reason ?? "",
      message: (e.message ?? "").slice(0, 1000),
      object: `${e.involvedObject?.kind ?? "?"}/${e.involvedObject?.name ?? "?"}`,
      at: e.lastTimestamp ?? e.eventTime ?? null,
      count: e.count ?? 1,
    }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 50);
  const status = live?.status ?? {};
  return {
    kind: w.kind,
    name: w.name,
    namespace,
    desired: live?.spec?.replicas ?? w.replicas,
    ready: status.readyReplicas ?? status.numberReady ?? 0,
    updated: status.updatedReplicas ?? status.updatedNumberScheduled ?? 0,
    available: status.availableReplicas ?? status.numberAvailable ?? 0,
    pods: pods.map((p) => {
      const containers = (p.status?.containerStatuses ?? []).map((c) => {
        const [state, detail] = Object.entries(c.state ?? {})[0] ?? ["unknown", {}];
        return {
          name: c.name ?? "?",
          ready: c.ready === true,
          restarts: c.restartCount ?? 0,
          state,
          reason: detail?.reason ?? null,
        };
      });
      return {
        name: p.metadata?.name ?? "?",
        phase: p.status?.phase ?? "Unknown",
        ready: (p.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
        restarts: containers.reduce((n, c) => n + c.restarts, 0),
        node: p.spec?.nodeName ?? null,
        startedAt: p.status?.startTime ?? null,
        containers,
      };
    }),
    events,
  };
}
