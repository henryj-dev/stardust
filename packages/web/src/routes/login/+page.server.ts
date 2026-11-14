import { fail, redirect } from "@sveltejs/kit";
import { apiClient, LOGIN_ERROR_COOKIE, OIDC_STATE_COOKIE, setSession } from "$lib/server/api";
import { safeNext } from "$lib/server/safe-next";
import type { Actions, PageServerLoad } from "./$types";

/** Holds the challenge between the password and the code. */
const CHALLENGE_COOKIE = "stardust_login_challenge";

export const load: PageServerLoad = async ({ cookies, url }) => {
  const error = cookies.get(LOGIN_ERROR_COOKIE) ?? null;
  if (error) cookies.delete(LOGIN_ERROR_COOKIE, { path: "/login" });
  const methods = await apiClient()
    .authMethods()
    .catch(() => ({ password: true, oidc: null }));
  return { oidc: methods.oidc, error, next: safeNext(url.searchParams.get("next")) };
};

export const actions: Actions = {
  password: async ({ request, cookies, url, locals }) => {
    const form = await request.formData();
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!username || !password) return fail(400, { username, error: "Enter your username and password." });
    const result = await apiClient(undefined, locals).login(username, password);
    if (!result.ok && result.reason === "second-factor") {
      cookies.set(CHALLENGE_COOKIE, result.challenge, {
        path: "/login",
        httpOnly: true,
        sameSite: "strict",
        secure: url.protocol === "https:",
        maxAge: 300,
      });
      return { username, secondFactor: true };
    }
    if (!result.ok) {
      return fail(result.reason === "locked" ? 429 : 401, {
        username,
        error:
          result.reason === "locked"
            ? "Too many failed attempts. Try again later."
            : result.reason === "off"
              ? "Password sign-in is off here: use single sign-on."
              : "Wrong username or password.",
      });
    }
    setSession(cookies, url, result.token);
    redirect(303, safeNext(url.searchParams.get("next")));
  },

  // The second step: a code from the authenticator app, or a recovery code.
  code: async ({ request, cookies, url, locals }) => {
    const challenge = cookies.get(CHALLENGE_COOKIE);
    const code = String((await request.formData()).get("code") ?? "").trim();
    if (!challenge) return fail(401, { error: "This sign-in has expired. Start again." });
    const result = await apiClient(undefined, locals).loginCode(challenge, code);
    if (!result.ok) {
      const expired = /expired/.test(result.message);
      if (expired) cookies.delete(CHALLENGE_COOKIE, { path: "/login" });
      return fail(401, {
        secondFactor: !expired,
        error: expired ? "This sign-in has expired. Start again." : "That code is not right.",
      });
    }
    cookies.delete(CHALLENGE_COOKIE, { path: "/login" });
    setSession(cookies, url, result.token);
    redirect(303, safeNext(url.searchParams.get("next")));
  },

  oidc: async ({ cookies, url, locals }) => {
    const { url: providerUrl, state } = await apiClient(undefined, locals).oidcStart();
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
