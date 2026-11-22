import { ApiError } from "@stardust/sdk";
import { error, fail } from "@sveltejs/kit";
import { requireClient } from "$lib/server/api";
import { needsReauth, reauthFrom } from "$lib/server/reauth";
import { signInRequests } from "$lib/server/sign-in-requests";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const client = requireClient(locals, url);
  if (!locals.user?.isAdmin) error(403, "Administrators only.");
  const users = await client.users();
  // Single sign-on attempts turned away for want of an account: whom an administrator may let in.
  const failed = await client.audit({ action: "auth.login.failed", limit: 200 }).catch(() => ({ events: [] }));
  return { users, waiting: signInRequests(failed.events, users), me: locals.user.username };
};

/** The server's reason for a refusal it explains (4xx); anything else is an error page. */
const refused = (err: unknown) => {
  if (needsReauth(err)) return fail(401, { error: "Confirm it is you first (below), then try again.", reauth: true });
  if (err instanceof ApiError && err.status < 500) return fail(err.status, { error: err.message });
  throw err;
};

export const actions: Actions = {
  reauth: async ({ locals, request, url }) => {
    const problem = await reauthFrom(requireClient(locals, url), await request.formData());
    return problem ? fail(403, { error: problem, reauth: true }) : { confirmed: true };
  },
  resetTotp: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const username = String((await request.formData()).get("username") ?? "");
    try {
      await client.resetTotp(username);
      return { updated: username };
    } catch (err) {
      return refused(err);
    }
  },
  create: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const username = String(form.get("username") ?? "").trim();
    const subject = String(form.get("subject") ?? "").trim();
    try {
      await client.createUser({
        username,
        displayName: String(form.get("displayName") ?? ""),
        isAdmin: form.get("isAdmin") === "on",
        ...(subject ? { oidc: { subject } } : {}),
      });
      // Someone who signs in through the provider needs no password, so no invitation.
      if (subject) return { created: { username, sso: true } };
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
  // Single sign-on for an existing account: link the person the provider names, or unlink.
  sso: async ({ locals, request, url }) => {
    const client = requireClient(locals, url);
    const form = await request.formData();
    const username = String(form.get("username") ?? "");
    const subject = String(form.get("subject") ?? "").trim();
    const unlink = form.get("op") === "unlink";
    if (!unlink && !subject) return fail(400, { error: "Give the person's single sign-on subject." });
    try {
      await client.updateUser(username, { oidc: unlink ? null : { subject } });
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
