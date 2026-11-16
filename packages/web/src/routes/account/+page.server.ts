import { ApiError } from "@stardust/sdk";
import { fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const client = requireClient(locals, url);
  return { sessions: await client.sessions() };
};

export const actions: Actions = {
  password: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const next = String(form.get("password") ?? "");
    if (next !== String(form.get("again") ?? "")) return fail(400, { passwordError: "The two new passwords differ." });
    try {
      await client.changePassword(String(form.get("current") ?? ""), next);
      return { changed: true };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { passwordError: err.message });
      throw err;
    }
  },
  end: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    try {
      await client.endSession(String((await request.formData()).get("session") ?? ""));
      return { endedSession: true };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { sessionError: err.message });
      throw err;
    }
  },
};
