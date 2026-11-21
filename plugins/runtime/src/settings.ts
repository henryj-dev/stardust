/**
 * A component's workload settings, read from and written to its deploy
 * directory (see @stardust/core gitops/workload): its service account,
 * probes, read-only root with writable paths, user and group ids, and
 * rolling one pod at a time. Each save is one commit, with CAS.
 */
import {
  type BoundRepo,
  CLUSTER_ROLES_FILE,
  checkWorkloadChange,
  commitWithCas,
  planClusterRoles,
  planWorkload,
  type RepoIO,
  type Route,
  type RouteResponse,
  readClusterRoles,
  readDirectoryWorkload,
  restrictedProblems,
  type WorkloadChange,
  WorkloadEditError,
  workloadNamespace,
} from "@stardust/core";

const MANIFEST = /\.ya?ml$/;

export interface ComponentRef {
  name: string;
  deployDir: string;
}

/** A directory's manifests at `at`, path → text. */
export async function readDir(at: BoundRepo, dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await at.list(dir)) {
    if (!MANIFEST.test(name)) continue;
    const file = await at.read(`${dir}/${name}`);
    if (file) files.set(`${dir}/${name}`, file.content);
  }
  return files;
}

export const atHead = async (repo: RepoIO): Promise<BoundRepo> => {
  const head = await repo.headSha();
  return { read: (p) => repo.readFile(p, head), list: (p) => repo.listDir(p, head) };
};

export const dirOf = (c: ComponentRef) => c.deployDir.replace(/\/+$/, "");

/** A commit result as the answer: committed, nothing to do, or the repository's refusal. */
export function answer(
  result: Awaited<ReturnType<typeof commitWithCas>>,
  audit: NonNullable<RouteResponse["audit"]>,
): RouteResponse {
  if (result.status === "error") {
    if (result.kind === "stale_head" || result.kind === "ref_race")
      return { status: 409, body: { error: "the deploy repository kept changing; try again" } };
    return { status: 502, body: { error: `deploy repository: ${result.message}` } };
  }
  return {
    status: 200,
    body: {
      status: result.status === "committed" ? "committed" : "up-to-date",
      deployCommit: result.status === "committed" ? result.sha : null,
    },
    ...(result.status === "committed" ? { audit } : {}),
  };
}

/** What a change says, for the commit message: field names, never values. */
const describe = (change: WorkloadChange) =>
  Object.keys(change)
    .map((k) => (k === "probes" ? `probes (${Object.keys(change.probes ?? {}).join(", ")})` : k))
    .join(", ");

export function workloadRoutes(input: {
  repo: RepoIO;
  component: (params: Readonly<Record<string, string>>) => Promise<ComponentRef | null>;
}): Route[] {
  const { repo, component } = input;
  return [
    {
      method: "GET",
      path: "/projects/:project/components/:component/workload",
      permission: "runtime:view",
      async handle({ params }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        const dir = dirOf(c);
        const files = await readDir(await atHead(repo), dir);
        const { settings, workloads } = readDirectoryWorkload(files, c.name);
        const ns = workloads > 0 ? workloadNamespace(files, dir) : null;
        const podSecurity: string[] = [];
        for (const [path, text] of files) {
          for (const p of restrictedProblems(text)) podSecurity.push(`${path.slice(dir.length + 1)}: ${p}`);
        }
        return {
          status: 200,
          body: { namespace: typeof ns === "string" ? ns : null, workloads, settings, podSecurity },
        };
      },
    },
    {
      method: "PUT",
      path: "/projects/:project/components/:component/workload",
      permission: "runtime:operate",
      audit: "runtime.workload",
      async handle({ params, body, user }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        let change: WorkloadChange;
        try {
          change = checkWorkloadChange(body);
        } catch (err) {
          return { status: 400, body: { error: (err as Error).message } };
        }
        if (Object.keys(change).length === 0) return { status: 400, body: { error: "nothing to change" } };
        const dir = dirOf(c);
        try {
          const result = await commitWithCas(repo, async (_head, at) => {
            const files = planWorkload(await readDir(at, dir), { dir, component: c.name, change });
            if (files.size === 0) return null;
            return {
              files,
              message: `chore(${params.project}/${c.name}): workload — ${describe(change)}\n\nBy ${user.username}.`,
            };
          });
          return answer(result, { projectId: params.project ?? "", target: c.name, detail: { ...change } });
        } catch (err) {
          if (err instanceof WorkloadEditError) return { status: 400, body: { error: err.message } };
          throw err;
        }
      },
    },
  ];
}

/**
 * ClusterRoles bound to the component's own service account. Cluster-wide,
 * so only roles listed in `runtime.allowedClusterRoles`, and only by an
 * administrator (`runtime:cluster-roles`); every change is audited.
 */
export function clusterRoleRoutes(input: {
  repo: RepoIO;
  component: (params: Readonly<Record<string, string>>) => Promise<ComponentRef | null>;
  allowed: readonly string[];
}): Route[] {
  const { repo, component, allowed } = input;
  const path = "/projects/:project/components/:component/cluster-roles";
  return [
    {
      method: "GET",
      path,
      permission: "runtime:view",
      async handle({ params }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        const dir = dirOf(c);
        const files = await readDir(await atHead(repo), dir);
        const { settings } = readDirectoryWorkload(files, c.name);
        const ns = settings ? workloadNamespace(files, dir) : null;
        return {
          status: 200,
          body: {
            allowed: [...allowed],
            roles: readClusterRoles(files.get(`${dir}/${CLUSTER_ROLES_FILE}`) ?? ""),
            serviceAccount: settings?.serviceAccount === true,
            namespace: typeof ns === "string" ? ns : null,
          },
        };
      },
    },
    {
      method: "PUT",
      path,
      permission: "runtime:cluster-roles",
      audit: "runtime.cluster-roles",
      async handle({ params, body, user }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        const roles = (body as { roles?: unknown } | null)?.roles;
        if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string"))
          return { status: 400, body: { error: "roles must be a list of ClusterRole names" } };
        const refused = roles.filter((r) => !allowed.includes(r));
        if (refused.length > 0) {
          return {
            status: 400,
            body: {
              error: `${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not in runtime.allowedClusterRoles${
                allowed.length === 0 ? ", which lists none" : ` (${allowed.join(", ")})`
              }`,
            },
          };
        }
        const want = [...new Set(roles as string[])].sort();
        const dir = dirOf(c);
        try {
          const result = await commitWithCas(repo, async (_head, at) => {
            const files = planClusterRoles(await readDir(at, dir), { dir, component: c.name, roles: want });
            if (files.size === 0) return null;
            return {
              files,
              message: `chore(${params.project}/${c.name}): cluster roles — ${want.length > 0 ? want.join(", ") : "none"}\n\nCluster-wide. By ${user.username}.`,
            };
          });
          return answer(result, { projectId: params.project ?? "", target: c.name, detail: { roles: want } });
        } catch (err) {
          if (err instanceof WorkloadEditError) return { status: 400, body: { error: err.message } };
          throw err;
        }
      },
    },
  ];
}
