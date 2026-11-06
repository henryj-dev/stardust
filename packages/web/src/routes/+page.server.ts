import { requireClient } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const client = requireClient(locals, url);
  const projects = await client.projects();
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name, githubRepo: p.githubRepo, lastRun: p.lastRun })),
  };
};
