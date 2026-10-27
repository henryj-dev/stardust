import { type Client, createClient } from "@stardust/sdk";
import { redirect } from "@sveltejs/kit";
import { STARDUST_API_URL } from "$app/env/private";

export const SESSION_COOKIE = "stardust_session";

export function apiClient(token?: string): Client {
  return createClient({
    baseUrl: STARDUST_API_URL,
    ...(token ? { token } : {}),
  });
}

/** The signed-in client, or a redirect to the sign-in page. */
export function requireClient(locals: App.Locals, from: URL): Client {
  if (!locals.token) redirect(303, `/login?next=${encodeURIComponent(from.pathname)}`);
  return apiClient(locals.token);
}
