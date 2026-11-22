import { ApiError } from "@stardust/sdk";
import { error } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { auditFilterFrom, olderLink } from "$lib/server/audit-filter";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const client = requireClient(locals, url);
  if (!locals.user?.isAdmin) error(403, "Only administrators can read the whole audit log.");
  const filter = auditFilterFrom(url, { project: true });
  try {
    const page = await client.audit(filter);
    return { filter, events: page.events, older: olderLink(url, page.next), problem: null };
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) return { filter, events: [], older: null, problem: err.message };
    throw err;
  }
};
