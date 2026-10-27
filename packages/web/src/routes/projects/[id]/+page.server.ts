import { requireClient } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  return { projectId: params.id, runs: await client.runs(params.id) };
};
