import { ApiError } from "@stardust/sdk";
import { error, fail, redirect } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { projectFields, readFields } from "$lib/server/project-form";
import { deployDirTemplate, findProject, requireAdmin, saveProject } from "$lib/server/project-save";
import { needsReauth, reauthFrom } from "$lib/server/reauth";
import { checkAccess } from "$lib/server/source-access";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  requireAdmin(locals);
  const stored = await findProject(client, params.id);
  if (!stored) error(404, "No such project.");
  const fields = projectFields(stored);
  return {
    fields,
    access: await checkAccess(client, fields.githubRepo),
    deployDirTemplate: await deployDirTemplate(client),
  };
};

export const actions: Actions = {
  // Asks about the repository as typed, keeping what else was typed; nothing is saved.
  check: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    requireAdmin(locals);
    const fields = readFields(await request.formData(), params.id);
    return { fields, errors: [], access: await checkAccess(client, fields.githubRepo) };
  },
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
    if (form.get("proof")) {
      const problem = await reauthFrom(client, form);
      if (problem) return fail(403, { deleteError: problem });
    }
    try {
      await client.deleteProject(params.id, { withdraw: form.get("withdraw") === "on" });
    } catch (err) {
      if (needsReauth(err))
        return fail(401, { deleteError: "Confirm it is you: enter your password or a code below." });
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { deleteError: err.message });
      throw err;
    }
    redirect(303, "/");
  },
};
