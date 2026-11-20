import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export interface Listing {
  instances: Array<{
    name: string;
    provider: string;
    origin: "created" | "adopted";
    namespace: string;
    workload: string;
    host: string;
    /** Its address outside the cluster, a LoadBalancer Service <name>-db. */
    external: { address: string; clusterIP: string | null } | null;
    /** Whether its superuser's connection can be shown (an instance stardust created). */
    connection: boolean;
    version: string | null;
    ready: boolean;
    present: boolean;
    grants: Array<{ role: string; database: string; project: string; layer: string }>;
    lastCheck: {
      status: "pending" | "passed" | "failed";
      detail: string | null;
      requestedAt: string;
      finishedAt: string | null;
    } | null;
  }>;
  unmanaged: Array<{
    provider: string;
    namespace: string;
    workload: string;
    version: string | null;
    ready: boolean;
    adoptable: boolean;
  }>;
  engines: Array<{ name: string; versions: string[]; namespace: string }>;
  backup: { schedule: string } | null;
  envEditing: boolean;
  restoreChecks: boolean;
  allowDelete: boolean;
  externalAddresses: boolean;
}

export interface Connection {
  name: string;
  role: string;
  database: string;
  password: string;
  inCluster: { host: string; port: number; url: string };
  external: { host: string; port: number; url: string } | null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  try {
    return await requireClient(locals, url).plugin("databases").get<Listing>("/databases");
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403))
      error(err.status, "Databases are not available here.");
    throw err;
  }
};

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const send = async (locals: App.Locals, url: URL, method: "POST" | "DELETE", path: string, body?: unknown) => {
  try {
    return {
      ok: true,
      result: await requireClient(locals, url).plugin("databases").send<Record<string, unknown>>(method, path, body),
    };
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
    if (err instanceof ApiError && err.status === 502) return fail(502, { error: err.message });
    throw err;
  }
};

export const actions: Actions = {
  create: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, "POST", "/databases", {
      name: text(f, "name"),
      provider: text(f, "provider") || undefined,
      version: text(f, "version") || undefined,
      storage: text(f, "storage") || undefined,
      cpu: text(f, "cpu") || undefined,
      memory: text(f, "memory") || undefined,
      // Only a form that offered the choice says no; otherwise the server's settings decide.
      external: f.has("offersExternal") ? f.get("external") === "on" : undefined,
    });
  },
  adopt: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, "POST", "/databases/adopt", {
      provider: text(f, "provider"),
      namespace: text(f, "namespace"),
      workload: text(f, "workload"),
      name: text(f, "name") || undefined,
    });
  },
  grant: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, "POST", `/databases/${encodeURIComponent(text(f, "instance"))}/grants`, {
      project: text(f, "project"),
      layer: text(f, "layer") || "_shared",
      role: text(f, "role"),
      database: text(f, "database") || undefined,
      envPrefix: text(f, "envPrefix") || undefined,
    });
  },
  external: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, "POST", `/databases/${encodeURIComponent(text(f, "instance"))}/external`);
  },
  // The superuser's connection, shown to the administrator who asked and to no one else; the server audits the asking.
  connection: async ({ locals, request, url }) => {
    const f = await request.formData();
    const instance = text(f, "instance");
    try {
      const connection = await requireClient(locals, url)
        .plugin("databases")
        .send<Connection>("POST", `/databases/${encodeURIComponent(instance)}/connection`);
      return { connection };
    } catch (err) {
      if (err instanceof ApiError && (err.status < 500 || err.status === 502))
        return fail(err.status, { error: err.message });
      throw err;
    }
  },
  check: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, "POST", `/databases/${encodeURIComponent(text(f, "instance"))}/restore-check`);
  },
  remove: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, "POST", `/databases/${encodeURIComponent(text(f, "instance"))}/delete`, {
      confirm: text(f, "confirm"),
    });
  },
  revoke: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(
      locals,
      url,
      "DELETE",
      `/databases/${encodeURIComponent(text(f, "instance"))}/grants/${encodeURIComponent(text(f, "role"))}`,
    );
  },
};
