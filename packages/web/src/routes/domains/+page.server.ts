import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export interface DomainRow {
  name: string;
  provider: string;
  registrar: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  rdapError: string | null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const client = requireClient(locals, url);
  try {
    return { domains: (await client.plugin("domains").get<{ domains: DomainRow[] }>("/domains")).domains };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403))
      error(err.status, "Domains are not available here.");
    throw err;
  }
};

export const actions: Actions = {
  sync: async ({ locals, url }) => {
    try {
      return {
        synced: await requireClient(locals, url).plugin("domains").send<{ zones: number }>("POST", "/domains/sync"),
      };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
      throw err;
    }
  },
};
