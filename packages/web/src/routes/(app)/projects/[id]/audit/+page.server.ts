import { ApiError } from "@stardust/sdk";
import { error } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { auditFilterFrom, olderLink } from "$lib/server/audit-filter";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const client = requireClient(locals, url);
  const filter = auditFilterFrom(url, { project: false });
  try {
    const page = await client.projectAudit(params.id, filter);
    return { projectId: params.id, filter, events: page.events, older: olderLink(url, page.next), problem: null };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 404) error(404, "No such project.");
    if (err.status === 403) error(403, "Only the project's maintainers can read its audit log.");
    if (err.status === 400) return { projectId: params.id, filter, events: [], older: null, problem: err.message };
    throw err;
  }
};
