import type { SessionUser } from "@stardust/sdk";

declare global {
  namespace App {
    interface Locals {
      /** The session token from the cookie. */
      token?: string;
      /** Who the token belongs to; absent when signed out or when the API could not be asked. */
      user?: SessionUser;
      /** The browser's address and user agent, passed on to the API for its audit log. */
      forward?: { forwardedFor?: string; userAgent?: string };
    }
  }
}
