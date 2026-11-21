import { redirect } from "@sveltejs/kit";

/**
 * Sends the browser to the identity provider: its sign-in page, or its page
 * that ends the session there. The address comes from the server (the
 * provider's discovery document), so it is on another origin by design, and
 * SvelteKit refuses such a redirect unless it is marked external. Only http(s)
 * addresses are followed.
 */
export function redirectToProvider(location: string): never {
  const url = new URL(location);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`refusing to send the browser to a ${url.protocol} address`);
  }
  redirect(303, url.href, { external: true });
}
