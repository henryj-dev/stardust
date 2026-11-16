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
  return {
    user: locals.user
      ? { username: locals.user.username, displayName: locals.user.displayName, isAdmin: locals.user.isAdmin }
      : null,
    capabilities,
  };
};
