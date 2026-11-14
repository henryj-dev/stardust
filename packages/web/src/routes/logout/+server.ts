import { redirect } from "@sveltejs/kit";
import { apiClient, SESSION_COOKIE } from "$lib/server/api";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ cookies, locals }) => {
  // End the session on the server too; a cookie deleted only here would leave the token valid.
  const ended = locals.token
    ? await apiClient(locals.token, locals)
        .logout()
        .catch(() => ({}) as { redirect?: string })
    : {};
  cookies.delete(SESSION_COOKIE, { path: "/" });
  // A single sign-on session is ended at the provider too, which sends the browser back to /login.
  redirect(303, ended.redirect ?? "/login");
};
