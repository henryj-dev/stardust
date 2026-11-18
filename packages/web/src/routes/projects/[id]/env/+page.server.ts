import { ApiError, type Client } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { envFormChange, valueFromFile } from "$lib/server/env-form";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  try {
    return { projectId: params.id, env: await client.env(params.id), off: null };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 404 && /not enabled/.test(err.message))
      return { projectId: params.id, env: null, off: err.message };
    if (err.status === 404) error(404, "No such project.");
    throw err;
  }
};

/** Runs one change. A failure says why and which name; it never sends a value back to the page. */
async function apply(client: Client, projectId: string, form: FormData, op: "set" | "unset") {
  const fromFile = op === "set" ? await valueFromFile(form) : null;
  if (fromFile) {
    return fail(400, {
      layer: String(form.get("layer") ?? ""),
      name: String(form.get("name") ?? ""),
      error: fromFile.error,
    });
  }
  const parsed = envFormChange(form, op);
  if ("error" in parsed) return fail(400, { layer: parsed.layer, name: parsed.name, error: parsed.error });
  try {
    const result = await client.changeEnv(projectId, parsed.layer, parsed.change);
    return { layer: parsed.layer, name: parsed.name, result };
  } catch (err) {
    if (err instanceof ApiError && err.status < 500)
      return fail(err.status, { layer: parsed.layer, name: parsed.name, error: err.message });
    throw err;
  }
}

/** Moves the hand-made env of a layer's component into the layer, with nothing else changed. */
async function adopt(client: Client, projectId: string, form: FormData) {
  const layer = String(form.get("layer") ?? "");
  const revision = String(form.get("revision") ?? "");
  try {
    const result = await client.changeEnv(projectId, layer, { expectedRevision: revision, adopt: true });
    return { layer, name: "", result };
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return fail(err.status, { layer, name: "", error: err.message });
    throw err;
  }
}

export const actions: Actions = {
  adopt: async ({ locals, params, request, url }) =>
    adopt(requireClient(locals, url), params.id, await request.formData()),
  set: async ({ locals, params, request, url }) =>
    apply(requireClient(locals, url), params.id, await request.formData(), "set"),
  unset: async ({ locals, params, request, url }) =>
    apply(requireClient(locals, url), params.id, await request.formData(), "unset"),
};
