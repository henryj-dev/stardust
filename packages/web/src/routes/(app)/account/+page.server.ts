import { ApiError } from "@stardust/sdk";
import { fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { needsReauth, reauthFrom } from "$lib/server/reauth";
import { DEFAULT_TOKEN_EXPIRY, TOKEN_EXPIRY_CHOICES, tokenRequestFrom } from "$lib/server/token-form";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
  const client = requireClient(locals, url);
  // A new token's secret is in this page once: keep it out of caches and the back button.
  setHeaders({ "cache-control": "no-store" });
  const [sessions, totp, tokens] = await Promise.all([client.sessions(), client.totp(), client.listTokens()]);
  return {
    sessions,
    totp,
    tokens,
    tokenExpiry: { choices: TOKEN_EXPIRY_CHOICES.map((c) => ({ ...c })), default: DEFAULT_TOKEN_EXPIRY },
  };
};

const refusal = (err: unknown) => {
  if (err instanceof ApiError && err.status < 500) return fail(err.status, { totpError: err.message });
  throw err;
};

export const actions: Actions = {
  reauth: async ({ locals, request, url }) => {
    const problem = await reauthFrom(requireClient(locals, url), await request.formData());
    return problem ? fail(403, { tokenError: problem, reauth: true }) : { confirmed: true };
  },
  createToken: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const asked = tokenRequestFrom(await request.formData());
    if (!asked.ok) return fail(400, { tokenError: asked.error, tokenName: asked.name, tokenExpiry: asked.expiry });
    const typed = {
      tokenName: asked.name,
      tokenExpiry: asked.expiresInDays === null ? "never" : String(asked.expiresInDays),
    };
    try {
      const { token } = await client.createToken(asked.name, asked.expiresInDays);
      // Returned in this response only: never stored, logged or put in a URL.
      return { createdToken: { name: asked.name, token } };
    } catch (err) {
      if (needsReauth(err))
        return fail(401, {
          tokenError: "Confirm it is you first (below), then make the token again.",
          reauth: true,
          ...typed,
        });
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { tokenError: err.message, ...typed });
      throw err;
    }
  },
  revokeToken: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    try {
      await client.revokeToken(String((await request.formData()).get("token") ?? ""));
      return { revokedToken: true };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return fail(err.status, { tokenError: err.message });
      throw err;
    }
  },
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
