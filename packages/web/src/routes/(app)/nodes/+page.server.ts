import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export interface NodeRow {
  hostname: string;
  state: "online" | "degraded" | "missing";
  lastBeatAt: string | null;
  uptimeS: number | null;
  agentVersion: string | null;
  metrics: {
    load: number[] | null;
    memTotalMb: number | null;
    memAvailMb: number | null;
    disk: Record<string, number>;
  } | null;
  hasToken: boolean;
}
export interface TokenRow {
  id: string;
  hostname: string;
  label: string | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const nodes = requireClient(locals, url).plugin("nodes");
  try {
    const [n, t] = await Promise.all([
      nodes.get<{ nodes: NodeRow[] }>("/nodes"),
      nodes.get<{ tokens: TokenRow[] }>("/tokens"),
    ]);
    return { nodes: n.nodes, tokens: t.tokens };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403))
      error(err.status, "Nodes are not available here.");
    throw err;
  }
};

const refusal = (err: unknown) => {
  if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
  throw err;
};

export const actions: Actions = {
  issue: async ({ locals, request, url }) => {
    const form = await request.formData();
    try {
      const issued = await requireClient(locals, url)
        .plugin("nodes")
        .send<{ hostname: string; token: string }>("POST", "/tokens", {
          hostname: String(form.get("hostname") ?? "").trim(),
          label: String(form.get("label") ?? "").trim() || undefined,
        });
      return { issued };
    } catch (err) {
      return refusal(err);
    }
  },
  revoke: async ({ locals, request, url }) => {
    const form = await request.formData();
    try {
      await requireClient(locals, url)
        .plugin("nodes")
        .send("DELETE", `/tokens/${encodeURIComponent(String(form.get("id") ?? ""))}`);
      return { revoked: true };
    } catch (err) {
      return refusal(err);
    }
  },
};
