import { error } from "@sveltejs/kit";
import { apiClient } from "$lib/server/api";
import type { RequestHandler } from "./$types";

/** Relays the API's event stream, so the browser never holds the token. */
export const GET: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.token) error(401, "sign in first");
  const upstream = await apiClient(locals.token).events(params.id, request.signal);
  return new Response(upstream.body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
};
