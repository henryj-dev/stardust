import { redirect } from "@sveltejs/kit";
import { apiClient, LOGIN_ERROR_COOKIE, OIDC_STATE_COOKIE, setSession } from "$lib/server/api";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, cookies }) => {
  const state = cookies.get(OIDC_STATE_COOKIE) ?? "";
  cookies.delete(OIDC_STATE_COOKIE, { path: "/login/oidc" });
  const result = await apiClient().oidcCallback(url.searchParams.toString(), state);
  if (!result.ok) {
    // Carried in a cookie, not the URL, so nobody can link to the sign-in page with text of their own.
    cookies.set(LOGIN_ERROR_COOKIE, result.message || "Sign-in failed.", {
      path: "/login",
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      maxAge: 60,
    });
    redirect(303, "/login");
  }
  setSession(cookies, url, result.token);
  // The browser arrived here from the provider's site, so a redirect from this
  // response would still count as cross-site and the Strict session cookie
  // would not be sent with it. A page that moves on by itself is same-site.
  return new Response(
    '<!doctype html><meta http-equiv="refresh" content="0;url=/"><title>Signed in</title><a href="/">Continue</a>',
    {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
};
