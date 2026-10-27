import { fail, redirect } from "@sveltejs/kit";
import { apiClient, LOGIN_ERROR_COOKIE, OIDC_STATE_COOKIE, setSession } from "$lib/server/api";
import { safeNext } from "$lib/server/safe-next";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ cookies, url }) => {
  const error = cookies.get(LOGIN_ERROR_COOKIE) ?? null;
  if (error) cookies.delete(LOGIN_ERROR_COOKIE, { path: "/login" });
  const methods = await apiClient()
    .authMethods()
    .catch(() => ({ password: true, oidc: null }));
  return { oidc: methods.oidc, error, next: safeNext(url.searchParams.get("next")) };
};

export const actions: Actions = {
  password: async ({ request, cookies, url }) => {
    const form = await request.formData();
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!username || !password) return fail(400, { username, error: "Enter your username and password." });
    const result = await apiClient().login(username, password);
    if (!result.ok) {
      return fail(result.reason === "locked" ? 429 : 401, {
        username,
        error:
          result.reason === "locked" ? "Too many failed attempts. Try again later." : "Wrong username or password.",
      });
    }
    setSession(cookies, url, result.token);
    redirect(303, safeNext(url.searchParams.get("next")));
  },

  oidc: async ({ cookies, url }) => {
    const { url: providerUrl, state } = await apiClient().oidcStart();
    // Lax, not Strict: the provider sends the browser back with a cross-site
    // navigation, and a Strict cookie would not come along with it.
    cookies.set(OIDC_STATE_COOKIE, state, {
      path: "/login/oidc",
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      maxAge: 600,
    });
    redirect(303, providerUrl);
  },
};
