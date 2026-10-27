declare global {
  namespace App {
    interface Locals {
      /** The session token from the cookie. */
      token?: string;
    }
  }
}

export {};
