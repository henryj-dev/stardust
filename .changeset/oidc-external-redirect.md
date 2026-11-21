---
"stardust": patch
---

Signing in with OpenID Connect works again: the sign-in button and signing
out of a single sign-on session send the browser to the identity provider, and
SvelteKit 3 refuses a redirect to another origin unless it is marked external,
so both ended in a 500. They now go through one helper that marks the address
external and follows only http(s) addresses.
