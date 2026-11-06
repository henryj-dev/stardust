import { error } from "@sveltejs/kit";
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
  default: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    requireAdmin(locals);
    // Read again at save time: the definition and metadata go back as they are now, not as the page saw them.
    const stored = await findProject(client, params.id);
    if (!stored) error(404, "No such project.");
    return saveProject(client, params.id, await request.formData(), stored);
  },
};
