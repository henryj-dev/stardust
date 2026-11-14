import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import type { RuntimeView } from "$lib/runtime";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

const runtimePath = (project: string, component: string) =>
  `/projects/${encodeURIComponent(project)}/components/${encodeURIComponent(component)}`;

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  try {
    const [deliveries, capabilities] = await Promise.all([
      client.deliveries(params.id, params.name),
      client.capabilities(),
    ]);
    const has = (c: string) => capabilities.plugins.some((p) => p.capabilities.includes(c));
    let runtime: RuntimeView | null = null;
    let runtimeError: string | null = null;
    if (has("runtime.view")) {
      try {
        runtime = await client.plugin("runtime").get<RuntimeView>(runtimePath(params.id, params.name));
      } catch (err) {
        // What runs is extra: the page still shows deliveries when the cluster cannot be read.
        runtimeError = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      projectId: params.id,
      component: params.name,
      deliveries,
      runtime,
      runtimeError,
      can: { restart: has("runtime.restart"), scale: has("runtime.scale") },
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) error(404, "No such component.");
    throw err;
  }
};

/** The server's reason for a refusal it explains (4xx); anything else is an error page. */
const reason = (err: unknown): { status: number; message: string } => {
  if (err instanceof ApiError && err.status < 500) return { status: err.status, message: err.message };
  throw err;
};

export const actions: Actions = {
  // Points the component back at an earlier delivery. The server checks write access.
  rollback: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const job = (await request.formData()).get("job");
    try {
      const result = await client.rollback(params.id, params.name, typeof job === "string" && job ? job : undefined);
      return { rolledBack: result };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { rollbackError: r.message });
    }
  },
  // A restart is a commit: the GitOps controller rolls the workloads out.
  restart: async ({ locals, params, url }) => {
    const client = requireClient(locals, url);
    try {
      const result = await client
        .plugin("runtime")
        .send<{ status: string; deployCommit: string | null }>(
          "POST",
          `${runtimePath(params.id, params.name)}/restart`,
        );
      return { restarted: result };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { runtimeActionError: r.message });
    }
  },
  scale: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const kind = String(form.get("kind") ?? "");
    const name = String(form.get("workload") ?? "");
    const replicas = Number(form.get("replicas"));
    if (!Number.isInteger(replicas)) return fail(400, { runtimeActionError: "Replicas must be a whole number." });
    try {
      const path = `${runtimePath(params.id, params.name)}/workloads/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/replicas`;
      const result = await client
        .plugin("runtime")
        .send<{ status: string; deployCommit: string | null }>("PUT", path, { replicas });
      return { scaled: { name, replicas, ...result } };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { runtimeActionError: r.message });
    }
  },
};
