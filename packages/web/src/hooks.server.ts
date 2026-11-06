import type { Handle } from "@sveltejs/kit/hooks";
import { apiClient, SESSION_COOKIE } from "$lib/server/api";
import { isHealthCheck } from "$lib/server/health";

export const handle: Handle = async ({ event, resolve }) => {
  // Health checks must not depend on the API or a session.
  if (isHealthCheck(event.url.pathname)) return resolve(event);
  const token = event.cookies.get(SESSION_COOKIE);
  if (token) {
    // Ask once per request who the token belongs to. A token the API rejects
    // (expired, revoked, signed out elsewhere) is dropped here, so pages send
    // the browser to sign in instead of failing on their first API call. If
    // the API cannot be reached the token is kept and pages report the error.
    const user = await apiClient(token)
      .session()
      .catch(() => undefined);
    if (user === null) event.cookies.delete(SESSION_COOKIE, { path: "/" });
    else {
      event.locals.token = token;
      if (user) event.locals.user = user;
    }
  }
  return resolve(event);
};
