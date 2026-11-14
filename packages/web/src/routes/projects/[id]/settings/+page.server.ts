import { ApiError } from "@stardust/sdk";
import { error, fail, redirect } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { projectFields } from "$lib/server/project-form";
import { findProject, requireAdmin, saveProject } from "$lib/server/project-save";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  requireAdmin(locals);
  const stored = await findProject(client, params.id);
  if (!stored) error(404, "No such project.");
  return { fields: projectFields(stored) };
};

export const actions: Actions = {
  save: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    requireAdmin(locals);
    // Read again at save time: the definition and metadata go back as they are now, not as the page saw them.
    const stored = await findProject(client, params.id);
    if (!stored) error(404, "No such project.");
    return saveProject(client, params.id, await request.formData(), stored);
  },
  // Deleting is final: the form repeats the project's id, and the server checks it too.
  delete: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    requireAdmin(locals);
    const form = await request.formData();
    if (form.get("confirm") !== params.id) return fail(400, { deleteError: `Type ${params.id} to delete it.` });
    try {
      await client.deleteProject(params.id, { withdraw: form.get("withdraw") === "on" });
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { deleteError: err.message });
      throw err;
    }
    redirect(303, "/");
  },
};
