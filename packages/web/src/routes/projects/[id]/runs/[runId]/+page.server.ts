import { ApiError } from "@stardust/sdk";
import { error } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  try {
    return { projectId: params.id, run: await client.run(params.id, params.runId) };
  } catch (err) {
    // The API answers 404 for a project the user cannot read, too.
    if (err instanceof ApiError && err.status === 404) error(404, "No such run.");
    throw err;
  }
};
