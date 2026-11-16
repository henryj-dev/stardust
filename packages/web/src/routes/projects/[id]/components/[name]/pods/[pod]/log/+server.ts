import { error } from "@sveltejs/kit";
import { apiClient } from "$lib/server/api";
import { relayLog } from "$lib/server/log-relay";
import type { RequestHandler } from "./$types";

/** Relays a pod's log from the runtime plugin, so the browser never holds the token. */
export const GET: RequestHandler = async ({ locals, params, request, url }) => {
  if (!locals.token) error(401, "sign in first");
  const query = new URLSearchParams();
  for (const key of ["follow", "source", "container", "tail"]) {
    const value = url.searchParams.get(key);
    if (value) query.set(key, value);
  }
  const p = (s: string) => encodeURIComponent(s);
  const upstream = await apiClient(locals.token)
    .plugin("runtime")
    .raw(`/projects/${p(params.id)}/components/${p(params.name)}/pods/${p(params.pod)}/log?${query}`, request.signal);
  return relayLog(upstream);
};
