import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

interface Check {
  projectId: string;
  component: string;
  pinned: string;
  latestTag: string | null;
  latestDigest: string | null;
  newer: boolean;
  error: string | null;
  checkedAt: string;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  try {
    return await requireClient(locals, url).plugin("upstream-images").get<{ checks: Check[] }>("/checks");
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) error(err.status, "Not available here.");
    throw err;
  }
};

export const actions: Actions = {
  check: async ({ locals, url }) => {
    try {
      return {
        checked: (
          await requireClient(locals, url).plugin("upstream-images").send<{ checked: number }>("POST", "/checks")
        ).checked,
      };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
      throw err;
    }
  },
};
