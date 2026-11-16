/**
 * Runtime: what a component runs now (workloads, pods, events) and the few
 * changes an operator makes to it — restart, scale, resources. Every change
 * is a commit to the deploy repository, so the GitOps controller applies it
 * and does not revert it as drift.
 *
 *   runtime: {}
 *
 * The server's service account needs read access to pods, events and the
 * workloads in the components' namespaces (the chart's `runtime.enabled`).
 */
import {
  type BoundRepo,
  commitWithCas,
  definePlugin,
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
import { parse } from "yaml";
import { readWorkload } from "./live.ts";

/** Pod-template annotation a restart writes; changing it rolls the workload out. */
export const RESTART_ANNOTATION = "stardust.dev/restarted-at";

const MANIFEST = /\.ya?ml$/;
const KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

interface Needs {
  kube: NonNullable<Ports["kube"]>;
  deployRepo: NonNullable<Ports["deployRepo"]>;
  projects: NonNullable<Ports["projects"]>;
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

  return [
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
        return { status: 200, body: { component: c.name, deployDir: c.deployDir, workloads: views } };
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
  ];
}

export const plugin = definePlugin({
  manifest: {
    name: "runtime",
    description: "Shows what a component runs, and restarts, scales and sizes it through Git.",
  },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    return Object.keys(section).map((key) => `unknown key "${key}"`);
  },
  requires: ["kube", "deployRepo", "projects"],
  permissions: [
    { id: "runtime:view", description: "See a component's workloads, pods and events", grantedTo: "project-readers" },
    { id: "runtime:operate", description: "Restart, scale and size a component", grantedTo: "project-writers" },
  ],
  capabilities: ["runtime.view", "runtime.restart", "runtime.scale", "runtime.resources"],
  routes: ({ ports }: FeatureContext) => routes(ports as Needs),
});
