declare global {
  namespace App {
    interface Locals {
      /** The admin token from the session cookie, until user sign-in exists. */
      token?: string;
    }
  }
}

export {};
