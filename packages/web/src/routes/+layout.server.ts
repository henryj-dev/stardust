import { apiClient } from "$lib/server/api";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  // What this server has, so the navigation shows only what works here.
  const capabilities = locals.token
    ? await apiClient(locals.token, locals)
        .capabilities()
        .then((c) => c.plugins.flatMap((p) => p.capabilities))
        .catch(() => [] as string[])
    : [];
  // Whether single sign-on is set up, so pages offer it only where it works.
  const sso = locals.token
    ? await apiClient()
        .authMethods()
        .then((m) => m.oidc !== null)
        .catch(() => false)
    : false;
  return {
    sso,
    user: locals.user
      ? { username: locals.user.username, displayName: locals.user.displayName, isAdmin: locals.user.isAdmin }
      : null,
    capabilities,
  };
};
