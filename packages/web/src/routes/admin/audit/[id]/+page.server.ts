import { ApiError } from "@stardust/sdk";
import { error } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  try {
    return { event: await client.auditEvent(params.id) };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) error(err.status, "No such event.");
    throw err;
  }
};
