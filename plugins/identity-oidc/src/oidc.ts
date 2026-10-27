/**
 * Sign-in through any OpenID Connect provider: authorization code flow with
 * PKCE, a nonce, and a state that the caller must store and check once.
 *
 * This module only talks to the provider and checks what it returns
 * (signature, issuer, audience, expiry, nonce — done by openid-client). Who
 * the person is in stardust, and whether they may sign in, is the server's
 * decision from the claims returned here.
 */
import * as client from "openid-client";

export interface OidcOptions {
  /** The issuer URL; its /.well-known/openid-configuration is read. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Where the provider sends the browser back: the dashboard's callback page. */
  redirectUri: string;
  /** Scopes to ask for. openid is always included. */
  scopes?: readonly string[];
  /** The claim holding group names, for allowedGroups and adminGroups. */
  groupsClaim?: string;
  /** Tests only: allow an http issuer. */
  allowInsecureRequests?: boolean;
}

/** What the caller stores (server side) between start and finish. */
export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface Identity {
  issuer: string;
  subject: string;
  /** preferred_username, else the local part of email; may be absent. */
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  groups: string[];
}

export interface Oidc {
  start(): Promise<{ url: string; pending: PendingLogin }>;
  /** callbackUrl is the full URL the provider redirected to, query included. */
  finish(callbackUrl: string, pending: PendingLogin): Promise<Identity>;
}

export async function createOidc(options: OidcOptions): Promise<Oidc> {
  const insecure = options.allowInsecureRequests ? { execute: [client.allowInsecureRequests] } : undefined;
  const config = await client.discovery(
    new URL(options.issuer),
    options.clientId,
    options.clientSecret,
    undefined,
    insecure,
  );
  // Also check the ID token's signature against the provider's published keys.
  // The specification lets a client trust a token that came straight from the
  // token endpoint over TLS; openid-client does by default. Checking costs one
  // cached JWKS fetch and does not rest on TLS alone.
  client.enableNonRepudiationChecks(config);
  const scope = [...new Set(["openid", ...(options.scopes ?? ["profile", "email"])])].join(" ");
  const groupsClaim = options.groupsClaim ?? "groups";

  return {
    async start() {
      const pending: PendingLogin = {
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier: client.randomPKCECodeVerifier(),
      };
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: options.redirectUri,
        scope,
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(pending.codeVerifier),
        code_challenge_method: "S256",
      });
      return { url: url.href, pending };
    },

    async finish(callbackUrl, pending) {
      const current = new URL(callbackUrl);
      const expected = new URL(options.redirectUri);
      if (current.origin + current.pathname !== expected.origin + expected.pathname) {
        throw new Error("the callback URL is not the configured redirect URI");
      }
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error("the provider returned no ID token");
      const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
      const email = str(claims.email);
      const rawGroups = claims[groupsClaim];
      return {
        issuer: claims.iss,
        subject: claims.sub,
        username: str(claims.preferred_username) ?? (email ? (email.split("@")[0] ?? null) : null),
        email,
        emailVerified: claims.email_verified === true,
        name: str(claims.name),
        groups: Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === "string") : [],
      };
    },
  };
}

export interface AccessRules {
  /** When set, only members of one of these groups may sign in. */
  allowedGroups?: readonly string[];
  /** Members of these groups are administrators. */
  adminGroups?: readonly string[];
}

/** Whether this identity may sign in, and as an administrator. */
export function decideAccess(identity: Identity, rules: AccessRules): { allowed: boolean; isAdmin: boolean } {
  const inAny = (groups?: readonly string[]) => (groups ?? []).some((g) => identity.groups.includes(g));
  const isAdmin = inAny(rules.adminGroups);
  const allowed = rules.allowedGroups === undefined || isAdmin || inAny(rules.allowedGroups);
  return { allowed, isAdmin };
}
