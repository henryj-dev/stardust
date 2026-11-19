import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

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

export const actions: Actions = {
  // Stops a job that has not finished. The server checks write access.
  cancel: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const job = (await request.formData()).get("job");
    if (typeof job !== "string" || job === "") return fail(400, { cancelError: "Which job?", job: "" });
    try {
      await client.cancelJob(params.id, params.runId, job);
      return { cancelled: job };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { cancelError: err.message, job });
      throw err;
    }
  },
};
