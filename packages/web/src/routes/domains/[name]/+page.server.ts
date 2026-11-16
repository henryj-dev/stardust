import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

interface Detail {
  domain: { name: string; provider: string; registrar: string | null; expiresAt: string | null; nameservers: string[] };
  capabilities: { views: string[]; proxied: boolean; asyncApply: boolean };
  records: Array<{
    id: string;
    name: string;
    type: string;
    content: string;
    ttl: number;
    view: string | null;
    proxied?: boolean;
  }>;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
  try {
    return await requireClient(locals, url)
      .plugin("domains")
      .get<Detail>(`/domains/${encodeURIComponent(params.name)}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) error(err.status, "No such domain.");
    throw err;
  }
};

const refusal = (err: unknown) => {
  if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
  throw err;
};

export const actions: Actions = {
  set: async ({ locals, params, request, url }) => {
    const form = await request.formData();
    const view = String(form.get("view") ?? "");
    try {
      const result = await requireClient(locals, url)
        .plugin("domains")
        .send<{ served: boolean }>("PUT", `/domains/${encodeURIComponent(params.name)}/records`, {
          name: String(form.get("name") ?? "").trim(),
          type: String(form.get("type") ?? ""),
          content: String(form.get("content") ?? "").trim(),
          ttl: Number(form.get("ttl") ?? 300),
          ...(view ? { view } : {}),
          ...(form.has("proxied") ? { proxied: form.get("proxied") === "on" } : {}),
        });
      return { saved: result };
    } catch (err) {
      return refusal(err);
    }
  },
  remove: async ({ locals, params, request, url }) => {
    const form = await request.formData();
    const view = String(form.get("view") ?? "");
    try {
      await requireClient(locals, url)
        .plugin("domains")
        .send(
          "DELETE",
          `/domains/${encodeURIComponent(params.name)}/records/${encodeURIComponent(String(form.get("id") ?? ""))}${view ? `?view=${encodeURIComponent(view)}` : ""}`,
        );
      return { removed: true };
    } catch (err) {
      return refusal(err);
    }
  },
};
