import { ApiError, type Client, type ProjectView } from "@stardust/sdk";
import { error, fail, redirect } from "@sveltejs/kit";
import { parseFields, readFields } from "./project-form.ts";

/** Project pages for administrators only. The server refuses anyone else too; this keeps the page from rendering. */
export function requireAdmin(locals: App.Locals): void {
  if (!locals.user?.isAdmin) error(403, "Only administrators can change projects.");
}

/**
 * Saves the form. `stored` is the project being edited, or null when creating one.
 * The server replaces the whole project, so the parts this form does not edit
 * (the pipeline definition and metadata) are sent back as they were stored.
 */
export async function saveProject(client: Client, id: string, form: FormData, stored: ProjectView | null) {
  const fields = readFields(form, id);
  const parsed = parseFields(fields);
  if (!parsed.ok) return fail(400, { fields, errors: parsed.errors });
  try {
    await client.putProject(id, {
      name: parsed.name,
      githubRepo: parsed.githubRepo,
      components: parsed.components,
      pipelineDef: stored?.pipelineDef ?? null,
      metadata: stored?.metadata ?? {},
    });
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return fail(err.status, { fields, errors: [err.message] });
    throw err;
  }
  redirect(303, `/projects/${encodeURIComponent(id)}`);
}

/** The stored project, or null when there is none (404). */
export async function findProject(client: Client, id: string): Promise<ProjectView | null> {
  try {
    return await client.project(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
