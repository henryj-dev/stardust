import { ApiError } from "@stardust/sdk";
import { fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const client = requireClient(locals, url);
  const [sessions, totp] = await Promise.all([client.sessions(), client.totp()]);
  return { sessions, totp };
};

const refusal = (err: unknown) => {
  if (err instanceof ApiError && err.status < 500) return fail(err.status, { totpError: err.message });
  throw err;
};

export const actions: Actions = {
  totpSetup: async ({ locals, url }) => {
    try {
      return { setup: await requireClient(locals, url).totpSetup() };
    } catch (err) {
      return refusal(err);
    }
  },
  totpConfirm: async ({ locals, request, url }) => {
    try {
      const codes = await requireClient(locals, url).totpConfirm(
        String((await request.formData()).get("code") ?? "").trim(),
      );
      return { recoveryCodes: codes };
    } catch (err) {
      return refusal(err);
    }
  },
  totpCodes: async ({ locals, request, url }) => {
    try {
      const codes = await requireClient(locals, url).totpRecoveryCodes(
        String((await request.formData()).get("code") ?? "").trim(),
      );
      return { recoveryCodes: codes };
    } catch (err) {
      return refusal(err);
    }
  },
  totpOff: async ({ locals, request, url }) => {
    try {
      await requireClient(locals, url).totpOff(String((await request.formData()).get("code") ?? "").trim());
      return { totpOff: true };
    } catch (err) {
      return refusal(err);
    }
  },
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
