import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals }) => ({
  user: locals.user
    ? { username: locals.user.username, displayName: locals.user.displayName, isAdmin: locals.user.isAdmin }
    : null,
});
