import type { Handle } from "@sveltejs/kit/hooks";
import { SESSION_COOKIE } from "$lib/server/api";

export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get(SESSION_COOKIE);
  if (token) event.locals.token = token;
  return resolve(event);
};
