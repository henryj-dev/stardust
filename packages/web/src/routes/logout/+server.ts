import { redirect } from "@sveltejs/kit";
import { apiClient, SESSION_COOKIE } from "$lib/server/api";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ cookies, locals }) => {
  // End the session on the server too; a cookie deleted only here would leave the token valid.
  if (locals.token)
    await apiClient(locals.token)
      .logout()
      .catch(() => {});
  cookies.delete(SESSION_COOKIE, { path: "/" });
  redirect(303, "/login");
};
