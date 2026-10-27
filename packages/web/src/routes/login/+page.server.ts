import { fail, redirect } from "@sveltejs/kit";
import { apiClient, SESSION_COOKIE } from "$lib/server/api";
import type { Actions } from "./$types";

const safeNext = (value: string | null): string => (value?.startsWith("/") && !value.startsWith("//") ? value : "/");

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const token = String((await request.formData()).get("token") ?? "").trim();
    if (!token) return fail(400, { error: "Enter the admin token." });
    if (!(await apiClient(token).checkToken())) return fail(401, { error: "That token was not accepted." });
    cookies.set(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: url.protocol === "https:",
      maxAge: 60 * 60 * 12,
    });
    redirect(303, safeNext(url.searchParams.get("next")));
  },
};
