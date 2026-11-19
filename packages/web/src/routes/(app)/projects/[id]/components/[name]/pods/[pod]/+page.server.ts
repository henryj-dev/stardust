import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url }) => ({
  projectId: params.id,
  component: params.name,
  pod: params.pod,
  source: url.searchParams.get("source") === "history" ? ("history" as const) : ("live" as const),
  container: url.searchParams.get("container") ?? "",
});
