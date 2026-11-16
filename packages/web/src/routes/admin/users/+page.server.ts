import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const client = requireClient(locals, url);
  if (!locals.user?.isAdmin) error(403, "Administrators only.");
  return { users: await client.users(), me: locals.user.username };
};

/** The server's reason for a refusal it explains (4xx); anything else is an error page. */
const refused = (err: unknown) => {
  if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
  throw err;
};

export const actions: Actions = {
  create: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const username = String(form.get("username") ?? "").trim();
    try {
      await client.createUser({
        username,
        displayName: String(form.get("displayName") ?? ""),
        isAdmin: form.get("isAdmin") === "on",
      });
      // A new local account has no password: hand it an invitation right away.
      const link = await client.issueLink(username, "invite");
      return { link: { username, url: `${url.origin}${link.path}`, expiresAt: link.expiresAt } };
    } catch (err) {
      return refused(err);
    }
  },
  link: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const username = String(form.get("username") ?? "");
    const purpose = form.get("purpose") === "reset" ? "reset" : "invite";
    try {
      const link = await client.issueLink(username, purpose);
      return { link: { username, url: `${url.origin}${link.path}`, expiresAt: link.expiresAt } };
    } catch (err) {
      return refused(err);
    }
  },
  update: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const username = String(form.get("username") ?? "");
    const change: { isAdmin?: boolean; disabled?: boolean } = {};
    if (form.has("isAdmin")) change.isAdmin = form.get("isAdmin") === "true";
    if (form.has("disabled")) change.disabled = form.get("disabled") === "true";
    try {
      await client.updateUser(username, change);
      return { updated: username };
    } catch (err) {
      return refused(err);
    }
  },
  endSessions: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const username = String((await request.formData()).get("username") ?? "");
    try {
      const ended = await client.endAllSessions(username);
      return { ended: { username, ...ended } };
    } catch (err) {
      return refused(err);
    }
  },
};
