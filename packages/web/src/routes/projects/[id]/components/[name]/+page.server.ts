import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  try {
    return {
      projectId: params.id,
      component: params.name,
      deliveries: await client.deliveries(params.id, params.name),
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) error(404, "No such component.");
    throw err;
  }
};

export const actions: Actions = {
  // Points the component back at an earlier delivery. The server checks write access.
  rollback: async ({ locals, params, request, url }) => {
    const client = requireClient(locals, url);
    const job = (await request.formData()).get("job");
    try {
      const result = await client.rollback(params.id, params.name, typeof job === "string" && job ? job : undefined);
      return { rolledBack: result };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { rollbackError: err.message });
      throw err;
    }
  },
};
