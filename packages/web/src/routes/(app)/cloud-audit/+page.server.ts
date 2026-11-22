import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export interface Listing {
  findings: Array<{
    source: string;
    recordId: string;
    rule: string;
    severity: "high" | "medium";
    reason: string;
    actorType: string;
    actorEmail: string;
    actorIp: string;
    occurredAt: string | null;
    foundAt: string;
  }>;
  sources: Array<{
    source: string;
    scannedUntil: string | null;
    lastScanAt: string | null;
    lastCount: number | null;
    lastError: string | null;
  }>;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  try {
    return await requireClient(locals, url).plugin("cloud-audit").get<Listing>("/findings");
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403))
      error(err.status, "Cloud audit is not available here.");
    throw err;
  }
};

export const actions: Actions = {
  scan: async ({ locals, url }) => {
    try {
      await requireClient(locals, url).plugin("cloud-audit").send("POST", "/scan");
      return { scanned: true };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
      throw err;
    }
  },
};
