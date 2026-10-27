import { type Client, createClient } from "@stardust/sdk";
import type { Cookies } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { STARDUST_API_URL } from "$app/env/private";

export const SESSION_COOKIE = "stardust_session";
/** Holds the OpenID state between leaving for the provider and coming back. */
export const OIDC_STATE_COOKIE = "stardust_oidc_state";
/** A sign-in error to show once on the sign-in page. */
export const LOGIN_ERROR_COOKIE = "stardust_login_error";

export function setSession(cookies: Cookies, url: URL, token: string): void {
  cookies.set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: url.protocol === "https:",
    maxAge: 60 * 60 * 12,
  });
}

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
