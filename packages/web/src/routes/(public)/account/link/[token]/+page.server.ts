import { ApiError } from "@stardust/sdk";
import { fail, redirect } from "@sveltejs/kit";
import { apiClient } from "$lib/server/api";
import type { Actions } from "./$types";

export const actions: Actions = {
  // No sign-in: the link is the credential. The server checks it once.
  default: async ({ locals, params, request }) => {
    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("again") ?? "")) return fail(400, { error: "The two passwords differ." });
    try {
      await apiClient(undefined, locals).useLink(params.token, password);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
      throw err;
    }
    redirect(303, "/login?set=1");
  },
};
