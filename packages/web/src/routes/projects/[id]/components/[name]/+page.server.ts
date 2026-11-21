import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import type { ClusterRolesView, RuntimeView, SecretFilesView, WorkloadSettingsView } from "$lib/runtime";
import { requireClient } from "$lib/server/api";
import { readMounts } from "$lib/server/files-form";
import { needsReauth, reauthFrom } from "$lib/server/reauth";
import { readSecretFileForm, SecretFileFormError } from "$lib/server/secret-file-form";
import { readStorageForm } from "$lib/server/storage-form";
import { readWorkloadForm, WorkloadFormError } from "$lib/server/workload-form";
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
    const storage = await client.componentStorage(params.id, params.name).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    const access = await client.componentAccess(params.id, params.name).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    // How the pods run: the runtime plugin's workload settings, when it is enabled.
    const workload: WorkloadSettingsView | null = has("runtime.workload")
      ? await client
          .plugin("runtime")
          .get<WorkloadSettingsView>(`${runtimePath(params.id, params.name)}/workload`)
          .catch(() => null)
      : null;
    const clusterRoles: ClusterRolesView | null = has("runtime.cluster-roles")
      ? await client
          .plugin("runtime")
          .get<ClusterRolesView>(`${runtimePath(params.id, params.name)}/cluster-roles`)
          .catch(() => null)
      : null;
    const secretFiles: SecretFilesView | null = has("runtime.secret-files")
      ? await client
          .plugin("runtime")
          .get<SecretFilesView>(`${runtimePath(params.id, params.name)}/secret-files`)
          .catch(() => null)
      : null;
    return {
      files,
      storage,
      workload,
      clusterRoles,
      secretFiles,
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
  // The Workload section: every field it shows, as one commit. The server checks write access.
  workload: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    let change: ReturnType<typeof readWorkloadForm>;
    try {
      change = readWorkloadForm(await request.formData());
    } catch (err) {
      if (err instanceof WorkloadFormError) return fail(400, { workloadError: err.message });
      throw err;
    }
    try {
      const result = await client
        .plugin("runtime")
        .send<{ status: string; deployCommit: string | null }>(
          "PUT",
          `${runtimePath(params.id, params.name)}/workload`,
          change,
        );
      return { workloadSaved: result };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { workloadError: r.message });
    }
  },
  // Cluster-wide roles for the component's own account: exactly the ticked ones (administrators; the server checks).
  clusterRoles: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const roles = (await request.formData()).getAll("roles").map(String);
    try {
      const result = await client
        .plugin("runtime")
        .send<{ status: string; deployCommit: string | null }>(
          "PUT",
          `${runtimePath(params.id, params.name)}/cluster-roles`,
          { roles },
        );
      return { clusterRolesSaved: result };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { clusterRolesError: r.message });
    }
  },
  // Secret files: add (generate or upload), replace or delete one key (administrators; the server checks).
  secretFile: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    let req: Awaited<ReturnType<typeof readSecretFileForm>>;
    try {
      req = await readSecretFileForm(form);
    } catch (err) {
      if (err instanceof SecretFileFormError) return fail(400, { secretFileError: err.message });
      throw err;
    }
    if (form.get("proof")) {
      const problem = await reauthFrom(client, form);
      if (problem) return fail(403, { secretFileError: problem });
    }
    const path = `${runtimePath(params.id, params.name)}/secret-files/${encodeURIComponent(req.set)}/keys/${encodeURIComponent(req.key)}`;
    const method = ({ add: "POST", replace: "PUT", delete: "DELETE" } as const)[req.op];
    try {
      const result = await client
        .plugin("runtime")
        .send<{ status: string; deployCommit: string | null }>(
          method,
          path,
          req.op === "delete" ? undefined : req.body,
        );
      return { secretFileSaved: { ...result, op: req.op, set: req.set, key: req.key } };
    } catch (err) {
      if (needsReauth(err))
        return fail(401, { secretFileError: "Confirm it is you: enter your password or a code, then try again." });
      const r = reason(err);
      return fail(r.status, { secretFileError: r.message });
    }
  },
  storage: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const change = readStorageForm(form);
    // Deleting data cannot be undone: it needs its own confirmation box.
    if (change.deleteData?.length && form.get("confirmDelete") !== "on") {
      return fail(400, { storageError: "Tick the confirmation to delete data: it cannot be undone." });
    }
    try {
      const result = await client.setComponentStorage(params.id, params.name, change);
      return { storageSaved: result };
    } catch (err) {
      const r = reason(err);
      return fail(r.status, { storageError: r.message });
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
