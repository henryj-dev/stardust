import { type Client, createClient, parseRegions, type RegionOptions } from "@stardust/sdk";
import type { Cookies } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { STARDUST_API_URL, STARDUST_HOME_REGION, STARDUST_REGIONS } from "$app/env/private";

export const SESSION_COOKIE = "stardust_session";
/** Holds the OpenID state between leaving for the provider and coming back. */
export const OIDC_STATE_COOKIE = "stardust_oidc_state";
/** Where to return after signing in at the provider. */
export const OIDC_NEXT_COOKIE = "stardust_oidc_next";
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

/**
 * Several regions shown as one (`STARDUST_REGIONS=name=https://…,…`): the
 * home region is STARDUST_HOME_REGION, reached at STARDUST_API_URL (or the
 * one listed at that URL, or the first).
 */
function regions(): RegionOptions | undefined {
  const spec = STARDUST_REGIONS;
  if (!spec) return undefined;
  const urls = parseRegions(spec);
  if (STARDUST_HOME_REGION)
    return { urls: { ...urls, [STARDUST_HOME_REGION]: STARDUST_API_URL }, home: STARDUST_HOME_REGION };
  const home =
    Object.entries(urls).find(([, url]) => url.replace(/\/+$/, "") === STARDUST_API_URL.replace(/\/+$/, ""))?.[0] ??
    Object.keys(urls)[0];
  return home ? { urls, home } : undefined;
}
const REGIONS = regions();

/** A client for the API; with `locals`, it passes on who the browser is, for the audit log. */
export function apiClient(token?: string, locals?: App.Locals): Client {
  return createClient({
    baseUrl: STARDUST_API_URL,
    ...(REGIONS ? { regions: REGIONS } : {}),
    ...(token ? { token } : {}),
    ...(locals?.forward ? { forward: locals.forward } : {}),
  });
}

/** The signed-in client, or a redirect to the sign-in page. */
export function requireClient(locals: App.Locals, from: URL): Client {
  if (!locals.token) redirect(303, `/login?next=${encodeURIComponent(from.pathname)}`);
  return apiClient(locals.token, locals);
}
