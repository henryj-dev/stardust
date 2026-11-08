import { error } from "@sveltejs/kit";
import { apiClient } from "$lib/server/api";
import { relayLog } from "$lib/server/log-relay";
import type { RequestHandler } from "./$types";

/** Relays a job's build log from the API, so the browser never holds the token. */
export const GET: RequestHandler = async ({ locals, params, request, url }) => {
  if (!locals.token) error(401, "sign in first");
  const upstream = await apiClient(locals.token).buildLog(params.id, params.runId, params.job, {
    follow: url.searchParams.get("follow") === "true",
    // Leaving the page ends the API request, which ends the cluster request.
    signal: request.signal,
  });
  return relayLog(upstream);
};
