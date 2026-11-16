import { requireClient } from "$lib/server/api";
import type { PageServerLoad } from "./$types";

interface Costs {
  sources: Array<{ name: string; currency: string | null; total: number | null; error: string | null }>;
}

export const load: PageServerLoad = async ({ locals, url, parent }) => {
  const client = requireClient(locals, url);
  const { capabilities } = await parent();
  const [projects, costs] = await Promise.all([
    client.projects(),
    // Only where the server adds costs up, and only for those allowed to see them.
    capabilities.includes("costs.monthly")
      ? client
          .plugin("costs")
          .get<Costs>("/monthly")
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      githubRepo: p.githubRepo,
      lastRun: p.lastRun,
      // With several regions: which one owns it, and whether it answered.
      region: typeof p.metadata?.region === "string" ? p.metadata.region : null,
      regionUnreachable: (p as { regionUnreachable?: boolean }).regionUnreachable === true,
    })),
    costs,
  };
};
