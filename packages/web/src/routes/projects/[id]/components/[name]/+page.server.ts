import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import type { RuntimeView } from "$lib/runtime";
import { requireClient } from "$lib/server/api";
import { readMounts } from "$lib/server/files-form";
import type { Actions, PageServerLoad } from "./$types";

interface EnvLanding {
  revision: string | null;
  landing: Array<{ workload: string; state: string }>;
}

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
    const env: EnvLanding | null = has("runtime.env")
      ? await client
          .plugin("runtime")
          .get<EnvLanding>(`${runtimePath(params.id, params.name)}/env`)
          .catch(() => null)
      : null;
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
    // Without a deploy repository there are no files to show; the rest of the page still works.
    const files = await client.componentFiles(params.id, params.name).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    const access = await client.componentAccess(params.id, params.name).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    return {
      files,
      access,
      projectId: params.id,
      component: params.name,
      deliveries,
      runtime,
      runtimeError,
      env,
      isAdmin: locals.user?.isAdmin === true,
      can: { restart: has("runtime.restart"), scale: has("runtime.scale"), logs: has("runtime.logs") },
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
  // Starter manifests for an empty deploy directory (administrators; the server checks).
  scaffold: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const port = Number(form.get("port"));
    try {
      const result = await client.scaffold(params.id, params.name, {
        namespace: String(form.get("namespace") ?? ""),
        ...(Number.isInteger(port) && port > 0 ? { port } : {}),
        ...(form.get("createNamespace") === "on" ? { createNamespace: true } : {}),
        ...(form.get("expose") === "on" ? { expose: true } : {}),
        ...(form.get("registryPull") === "on" ? { registryPull: true } : {}),
        ...(form.get("podView") === "on" ? { podView: true } : {}),
      });
      return { scaffolded: result };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { scaffoldError: r.message });
    }
  },
  // The pull Secret, pod view and env variables, each as the form's checkbox says (administrators; the server checks).
  access: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const change: { registryPull?: boolean; podView?: boolean; envVars?: boolean } = {};
    for (const key of ["registryPull", "podView", "envVars"] as const) {
      // Only what the form offered: a hidden marker says the checkbox was there.
      if (form.get(`${key}.shown`) === "1") change[key] = form.get(key) === "on";
    }
    try {
      return { accessSaved: await client.setComponentAccess(params.id, params.name, change) };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { accessError: r.message });
    }
  },
  // After the registry login changes: every component's pull Secret, resealed in one commit.
  reseal: async ({ locals, url }) => {
    const client = requireClient(locals, url);
    try {
      return { resealed: await client.resealRegistryPull() };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { accessError: r.message });
    }
  },
  // Env secrets mounted as files: the whole list, as one commit. The server checks write access.
  files: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    try {
      const result = await client.setComponentFiles(params.id, params.name, readMounts(await request.formData()));
      return { filesSaved: result };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { filesError: r.message });
    }
  },
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
