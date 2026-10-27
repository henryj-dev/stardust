import { fail, redirect } from "@sveltejs/kit";
import { apiClient, SESSION_COOKIE } from "$lib/server/api";
import type { Actions } from "./$types";

const safeNext = (value: string | null): string => (value?.startsWith("/") && !value.startsWith("//") ? value : "/");

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
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
    cookies.set(SESSION_COOKIE, result.token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: url.protocol === "https:",
      maxAge: 60 * 60 * 12,
    });
    redirect(303, safeNext(url.searchParams.get("next")));
  },
};
