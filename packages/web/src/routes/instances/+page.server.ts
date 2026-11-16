import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

interface Instance {
  id: string;
  label: string;
  hostname: string;
  region: string;
  plan: string;
  os: string | null;
  state: string;
  mainIp: string | null;
  internalIp: string | null;
  protected: boolean;
}
interface Catalog {
  regions: Array<{ id: string; city: string; country: string }>;
  plans: Array<{ id: string; vcpus: number; memoryMb: number; diskGb: number; monthlyCost: number; regions: string[] }>;
  images: Array<{ id: string; name: string }>;
  networks: Array<{ id: string; name: string; region: string }>;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const api = requireClient(locals, url).plugin("instances");
  try {
    const [listing, catalog] = await Promise.all([
      api.get<{
        account: string;
        capabilities: { resize: boolean; console: boolean };
        instances: Instance[];
        ops: Array<Record<string, unknown>>;
      }>("/instances"),
      api.get<Catalog>("/catalog"),
    ]);
    return { ...listing, catalog };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403))
      error(err.status, "Instances are not available here.");
    throw err;
  }
};

const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const send = async (locals: App.Locals, url: URL, path: string, body: unknown) => {
  try {
    return {
      ok: true,
      result: await requireClient(locals, url).plugin("instances").send<Record<string, unknown>>("POST", path, body),
    };
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
    throw err;
  }
};

export const actions: Actions = {
  create: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, "/instances", {
      hostname: text(f, "hostname"),
      label: text(f, "label") || undefined,
      region: text(f, "region"),
      plan: text(f, "plan"),
      image: text(f, "image"),
      networks: f.getAll("networks").map(String),
    });
  },
  resize: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, `/instances/${encodeURIComponent(text(f, "id"))}/resize`, { plan: text(f, "plan") });
  },
  approve: async ({ locals, request, url }) => {
    const f = await request.formData();
    const r = await send(locals, url, `/instances/${encodeURIComponent(text(f, "id"))}/delete/approve`, {
      confirm: text(f, "confirm"),
    });
    return "result" in r ? { approved: { id: text(f, "id"), ticket: String(r.result.ticket) } } : r;
  },
  remove: async ({ locals, request, url }) => {
    const f = await request.formData();
    return send(locals, url, `/instances/${encodeURIComponent(text(f, "id"))}/delete`, { ticket: text(f, "ticket") });
  },
};
