import { ApiError } from "@stardust/sdk";
import { fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { formTarget } from "$lib/server/pull";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  return { projectId: params.id, runs: await client.runs(params.id) };
};

export const actions: Actions = {
  // Builds and delivers a commit someone chose. The server checks write access and the target.
  pull: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const target = formTarget(form.get("kind"), form.get("ref"));
    if (!target) return fail(400, { pullError: "Choose a branch, a tag or a commit." });
    try {
      const run = await client.pull(params.id, target);
      return { pulled: { ref: run.ref, sha: run.sha } };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { pullError: err.message });
      throw err;
    }
  },
};
