import { fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { emptyComponent, type ProjectFields, readFields } from "$lib/server/project-form";
import { deployDirTemplate, findProject, requireAdmin, saveProject } from "$lib/server/project-save";
import { checkAccess } from "$lib/server/source-access";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const client = requireClient(locals, url);
  requireAdmin(locals);
  const fields: ProjectFields = { id: "", name: "", githubRepo: "", components: [emptyComponent()] };
  return { fields, deployDirTemplate: await deployDirTemplate(client) };
};

export const actions: Actions = {
  // Asks about the repository as typed, keeping what else was typed; nothing is created.
  check: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    requireAdmin(locals);
    const form = await request.formData();
    const id = typeof form.get("id") === "string" ? String(form.get("id")).trim() : "";
    const fields = readFields(form, id);
    return { fields, errors: [], access: await checkAccess(client, fields.githubRepo) };
  },
  create: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    requireAdmin(locals);
    const form = await request.formData();
    const id = typeof form.get("id") === "string" ? String(form.get("id")).trim() : "";
    // Saving replaces a project, so creating must not land on one that exists.
    if (id !== "" && (await findProject(client, id))) {
      return fail(409, { fields: readFields(form, id), errors: [`A project with the id "${id}" already exists.`] });
    }
    return saveProject(client, id, form, null);
  },
};
