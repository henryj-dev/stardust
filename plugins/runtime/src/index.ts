/**
 * Runtime: what a component runs now (workloads, pods, events) and the few
 * changes an operator makes to it — restart, scale, resources. Every change
 * is a commit to the deploy repository, so the GitOps controller applies it
 * and does not revert it as drift.
 *
 *   runtime: {}
 *
 * The server's service account needs read access to pods, pod logs, events,
 * Services and the workloads in the components' namespaces (the chart's
 * `runtime.namespaces`, or `runtime.bindings` and a component's pod view). Pod logs come from the `logs` port: logs-kube for
 * live pods, logs-loki for pods that are gone.
 */
import {
  type BoundRepo,
  commitWithCas,
  definePlugin,
  ENV_REVISION_ANNOTATION,
  envConfigMapName,
  envLanding,
  type FeatureContext,
  findWorkloads,
  type Ports,
  type Resources,
  type Route,
  type RouteResponse,
  type RuntimeKind,
  setReplicas,
  setResources,
  stampPodTemplate,
  type Workload,
  WorkloadEditError,
} from "@stardust/core";
import { parse, parseAllDocuments } from "yaml";
import { readWorkload } from "./live.ts";
import { workloadRoutes } from "./settings.ts";

/** Pod-template annotation a restart writes; changing it rolls the workload out. */
export const RESTART_ANNOTATION = "stardust.dev/restarted-at";

const MANIFEST = /\.ya?ml$/;
const KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

interface Needs {
  kube: NonNullable<Ports["kube"]>;
  deployRepo: NonNullable<Ports["deployRepo"]>;
  projects: NonNullable<Ports["projects"]>;
  /** Optional: without a source of a kind, that kind of log answers 404. */
  logs?: Ports["logs"];
}

/** The component's manifests at `at`, path → text. */
async function manifests(at: BoundRepo, dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await at.list(dir)) {
    if (!MANIFEST.test(name)) continue;
    const file = await at.read(`${dir}/${name}`);
    if (file) files.set(`${dir}/${name}`, file.content);
  }
  return files;
}

/** The namespace a kustomization in the directory sets for its resources, if any. */
function kustomizeNamespace(files: ReadonlyMap<string, string>, dir: string): string | null {
  for (const name of ["kustomization.yaml", "kustomization.yml"]) {
    const text = files.get(`${dir}/${name}`);
    if (!text) continue;
    const doc = parse(text) as { namespace?: unknown } | null;
    if (typeof doc?.namespace === "string") return doc.namespace;
  }
  return null;
}

const notFound = (what: string): RouteResponse => ({ status: 404, body: { error: `unknown ${what}` } });

/** The Services a component's manifests declare: name and namespace, if they say. */
function findServices(files: ReadonlyMap<string, string>): Array<{ name: string; namespace: string | null }> {
  const out: Array<{ name: string; namespace: string | null }> = [];
  for (const text of files.values()) {
    for (const doc of parseAllDocuments(text)) {
      if (doc.errors.length > 0 || doc.get("kind") !== "Service") continue;
      const name = doc.getIn(["metadata", "name"]);
      const namespace = doc.getIn(["metadata", "namespace"]);
      if (typeof name === "string") out.push({ name, namespace: typeof namespace === "string" ? namespace : null });
    }
  }
  return out;
}

export interface ServiceView {
  name: string;
  namespace: string | null;
  type?: string;
  ports?: Array<{ port: number; protocol: string }>;
  /** The address outside the cluster a LoadBalancer got, once it has one. */
  external?: string | null;
  error?: string;
}

/** A Service as it runs: its type, ports and the external address it was given. */
async function readService(kube: Needs["kube"], name: string, namespace: string | null): Promise<ServiceView> {
  if (!namespace) return { name, namespace, error: "the manifests name no namespace" };
  const res = await kube.request(
    "GET",
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
  );
  if (res.status === 404) return { name, namespace, error: "not applied yet" };
  if (res.status === 403) return { name, namespace, error: "stardust cannot read this namespace" };
  if (res.status !== 200) return { name, namespace, error: `the cluster answered ${res.status}` };
  const live = JSON.parse(res.body) as {
    spec?: { type?: string; ports?: Array<{ port: number; protocol?: string }> };
    status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } };
  };
  const ingress = live.status?.loadBalancer?.ingress?.[0];
  return {
    name,
    namespace,
    type: live.spec?.type ?? "ClusterIP",
    ports: (live.spec?.ports ?? []).map((p) => ({ port: p.port, protocol: p.protocol ?? "TCP" })),
    external: ingress?.ip ?? ingress?.hostname ?? null,
  };
}

function routes(needs: Needs): Route[] {
  const { kube, deployRepo, projects } = needs;
  const repo = deployRepo.repo;

  const component = async (params: Readonly<Record<string, string>>) => {
    const project = await projects.get(params.project ?? "");
    return project?.components.find((c) => c.name === params.component) ?? null;
  };

  /** One commit of every manifest change `change` makes, with CAS. */
  const commit = (dir: string, message: string, change: (files: Map<string, string>) => Map<string, string>) =>
    commitWithCas(repo, async (_head, at) => {
      const changed = change(await manifests(at, dir));
      return changed.size === 0 ? null : { files: new Map(changed), message };
    });

  const committed = (
    result: Awaited<ReturnType<typeof commit>>,
    audit: NonNullable<RouteResponse["audit"]>,
  ): RouteResponse => {
    if (result.status === "error") return { status: 502, body: { error: `deploy repository: ${result.message}` } };
    return {
      status: 200,
      body: {
        status: result.status === "committed" ? "committed" : "up-to-date",
        deployCommit: result.status === "committed" ? result.sha : null,
      },
      ...(result.status === "committed" ? { audit } : {}),
    };
  };

  const editOne = async (
    params: Readonly<Record<string, string>>,
    what: string,
    edit: (text: string, kind: RuntimeKind, name: string) => { text: string; changed: boolean },
    detail: Record<string, unknown>,
  ): Promise<RouteResponse> => {
    const c = await component(params);
    if (!c) return notFound("component");
    const kind = params.kind as RuntimeKind;
    if (!KINDS.has(kind)) return notFound("workload kind");
    try {
      const result = await commit(
        c.deployDir,
        `chore(${params.project}/${c.name}): ${what} ${kind}/${params.name}`,
        (files) => {
          const owner = findWorkloads(files).find((w) => w.kind === kind && w.name === params.name);
          if (!owner) throw new WorkloadEditError(`no ${kind} ${params.name} in ${c.deployDir}`);
          const out = edit(files.get(owner.file) ?? "", kind, params.name ?? "");
          return out.changed ? new Map([[owner.file, out.text]]) : new Map();
        },
      );
      return committed(result, { projectId: params.project ?? "", target: `${c.name}/${kind}/${params.name}`, detail });
    } catch (err) {
      if (err instanceof WorkloadEditError) return { status: 400, body: { error: err.message } };
      throw err;
    }
  };

  /** The component's workloads with the namespace each runs in. */
  const placed = async (deployDir: string) => {
    const head = await repo.headSha();
    const files = await manifests(
      { read: (p) => repo.readFile(p, head), list: (p) => repo.listDir(p, head) },
      deployDir,
    );
    const fallback = kustomizeNamespace(files, deployDir);
    return findWorkloads(files).map((w) => ({ ...w, namespace: w.namespace ?? fallback }));
  };

  return [
    {
      method: "GET",
      path: "/projects/:project/components/:component/env",
      permission: "runtime:view",
      async handle({ params }) {
        const c = await component(params);
        if (!c) return notFound("component");
        const head = await repo.headSha();
        const at = { read: (p: string) => repo.readFile(p, head), list: (p: string) => repo.listDir(p, head) };
        const files = await manifests(at, c.deployDir);
        const rendered = files.get(`${c.deployDir}/env.configmap.yaml`);
        if (!rendered) return { status: 200, body: { revision: null, landing: [] } };
        const doc = parse(rendered) as {
          metadata?: { namespace?: string; annotations?: Record<string, string> };
        } | null;
        const revision = doc?.metadata?.annotations?.[ENV_REVISION_ANNOTATION] ?? null;
        const namespace = doc?.metadata?.namespace;
        if (!revision || !namespace) return { status: 200, body: { revision, landing: [] } };
        const ns = encodeURIComponent(namespace);
        const cm = await kube.request(
          "GET",
          `/api/v1/namespaces/${ns}/configmaps/${encodeURIComponent(envConfigMapName(c.name))}`,
        );
        const applied =
          cm.status === 200
            ? ((JSON.parse(cm.body) as { metadata?: { annotations?: Record<string, string> } }).metadata?.annotations?.[
                ENV_REVISION_ANNOTATION
              ] ?? null)
            : null;
        // The ConfigMap and the Secret are rendered and applied together; the server never reads Secrets.
        const objects = cm.status === 200 ? { revision: applied } : null;
        const landing = [];
        for (const w of await placed(c.deployDir)) {
          if (!w.namespace) continue;
          const res = await kube.request(
            "GET",
            `/apis/apps/v1/namespaces/${encodeURIComponent(w.namespace)}/${w.kind.toLowerCase()}s/${encodeURIComponent(w.name)}`,
          );
          const live =
            res.status === 200
              ? (JSON.parse(res.body) as {
                  metadata?: { generation?: number };
                  spec?: { replicas?: number; template?: { metadata?: { annotations?: Record<string, string> } } };
                  status?: Record<string, number>;
                })
              : null;
          const st = live?.status ?? {};
          const want = live?.spec?.replicas ?? st.desiredNumberScheduled ?? 1;
          const rolledOut =
            (st.observedGeneration ?? 0) >= (live?.metadata?.generation ?? 0) &&
            (st.updatedReplicas ?? st.updatedNumberScheduled ?? 0) >= want &&
            (st.availableReplicas ?? st.numberAvailable ?? 0) >= want;
          const templateRevision = live?.spec?.template?.metadata?.annotations?.[ENV_REVISION_ANNOTATION] ?? null;
          landing.push({
            workload: `${w.kind}/${w.name}`,
            state: envLanding(
              {
                configMap: objects,
                secret: objects,
                workload: live && templateRevision ? { templateRevision, rolledOut } : null,
              },
              revision,
            ),
          });
        }
        return { status: 200, body: { revision, applied, landing } };
      },
    },
    {
      method: "GET",
      path: "/projects/:project/components/:component/pods/:pod/log",
      permission: "runtime:view",
      async handle({ params, query, signal }) {
        const c = await component(params);
        if (!c) return notFound("component");
        const pod = params.pod ?? "";
        const kind = query.get("source") === "history" ? "history" : "live";
        const source = Object.values(needs.logs ?? {}).find((s) => s.kind === kind);
        if (!source) return { status: 404, body: { error: `no ${kind} log source is enabled (logs-kube, logs-loki)` } };
        // Only this component's pods: a live pod must match a workload's selector;
        // a gone one (history) must be named after one of its workloads.
        let namespace: string | null = null;
        for (const w of await placed(c.deployDir)) {
          if (!w.namespace) continue;
          if (
            kind === "history"
              ? pod.startsWith(`${w.name}-`)
              : (await readWorkload(kube, w, w.namespace)).pods.some((p) => p.name === pod)
          ) {
            namespace = w.namespace;
            break;
          }
        }
        if (!namespace) return notFound("pod");
        const tail = Number(query.get("tail") ?? "");
        const container = query.get("container");
        const result = await source.read({
          namespace,
          pod,
          ...(container ? { container } : {}),
          follow: kind === "live" && query.get("follow") === "true",
          ...(Number.isInteger(tail) && tail > 0 ? { tailLines: tail } : {}),
          signal,
        });
        if (result.state === "none") return { status: 410, body: { error: "this pod's log is not available" } };
        return { status: 200, stream: result.body };
      },
    },
    {
      method: "GET",
      path: "/projects/:project/components/:component",
      permission: "runtime:view",
      async handle({ params }) {
        const c = await component(params);
        if (!c) return notFound("component");
        const head = await repo.headSha();
        const files = await manifests(
          { read: (p) => repo.readFile(p, head), list: (p) => repo.listDir(p, head) },
          c.deployDir,
        );
        const fallback = kustomizeNamespace(files, c.deployDir);
        const workloads: Workload[] = findWorkloads(files);
        const views = [];
        for (const w of workloads) {
          const namespace = w.namespace ?? fallback;
          if (!namespace) {
            views.push({ kind: w.kind, name: w.name, error: "the manifests name no namespace" });
            continue;
          }
          views.push(await readWorkload(kube, w, namespace));
        }
        const services: ServiceView[] = [];
        for (const svc of findServices(files))
          services.push(await readService(kube, svc.name, svc.namespace ?? fallback));
        return { status: 200, body: { component: c.name, deployDir: c.deployDir, workloads: views, services } };
      },
    },
    {
      method: "POST",
      path: "/projects/:project/components/:component/restart",
      permission: "runtime:operate",
      audit: "runtime.restart",
      async handle({ params }) {
        const c = await component(params);
        if (!c) return notFound("component");
        const at = new Date().toISOString();
        const result = await commit(c.deployDir, `chore(${params.project}/${c.name}): restart`, (files) => {
          const out = new Map<string, string>();
          for (const [path, text] of files) {
            const stamped = stampPodTemplate(text, RESTART_ANNOTATION, at);
            if (stamped.changed) out.set(path, stamped.text);
          }
          return out;
        });
        return committed(result, { projectId: params.project ?? "", target: c.name, detail: { at } });
      },
    },
    {
      method: "PUT",
      path: "/projects/:project/components/:component/workloads/:kind/:name/replicas",
      permission: "runtime:operate",
      audit: "runtime.scale",
      async handle({ params, body }) {
        const replicas = (body as { replicas?: unknown } | null)?.replicas;
        if (typeof replicas !== "number") return { status: 400, body: { error: "replicas must be a number" } };
        return editOne(params, "scale", (text, kind, name) => setReplicas(text, kind, name, replicas), { replicas });
      },
    },
    {
      method: "PUT",
      path: "/projects/:project/components/:component/workloads/:kind/:name/resources",
      permission: "runtime:operate",
      audit: "runtime.resources",
      async handle({ params, body }) {
        const b = (body ?? {}) as { container?: unknown; requests?: unknown; limits?: unknown };
        if (typeof b.container !== "string") return { status: 400, body: { error: "container is required" } };
        const resources = {
          ...(b.requests ? { requests: b.requests } : {}),
          ...(b.limits ? { limits: b.limits } : {}),
        } as Resources;
        return editOne(
          params,
          "resources",
          (text, kind, name) => setResources(text, kind, name, b.container as string, resources),
          { container: b.container, ...resources },
        );
      },
    },
    ...workloadRoutes({ repo, component }),
  ];
}

export const plugin = definePlugin({
  manifest: {
    name: "runtime",
    description: "Shows what a component runs, and restarts, scales, sizes and configures it through Git.",
  },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    return Object.keys(section).map((key) => `unknown key "${key}"`);
  },
  requires: ["kube", "deployRepo", "projects"],
  // The pod log page reads these; without saying so, logs-kube and logs-loki are never built.
  uses: ["logs"],
  permissions: [
    { id: "runtime:view", description: "See a component's workloads, pods and events", grantedTo: "project-readers" },
    {
      id: "runtime:operate",
      description: "Restart, scale, size and configure a component",
      grantedTo: "project-writers",
    },
  ],
  capabilities: [
    "runtime.view",
    "runtime.env",
    "runtime.logs",
    "runtime.restart",
    "runtime.scale",
    "runtime.resources",
    "runtime.workload",
  ],
  routes: ({ ports }: FeatureContext) => routes(ports as Needs),
});
