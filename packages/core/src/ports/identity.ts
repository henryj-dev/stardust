/**
 * Sign-in through an outside identity provider. The provider proves who the
 * person is; whether they may sign in, and as what, is decided here in core
 * from what it returns.
 */

/** What the caller stores (server side) between start and finish. */
export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Asked the provider to sign the person in again (prompt=login). */
  reauth?: boolean;
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
  /** The provider's session id, for back-channel logout. */
  sid?: string | null;
  /** How the person signed in at the provider (`pwd`, `otp`, `mfa` …). */
  amr?: string[];
  /** When they last signed in at the provider, seconds since 1970. */
  authTime?: number | null;
  /** The ID token, kept to name the session when signing out at the provider. */
  idToken?: string;
}

/** What a back-channel logout token says ended at the provider. */
export interface LogoutNotice {
  subject: string | null;
  sid: string | null;
  /** The token's id, used once. */
  jti: string;
  expiresAt: Date;
}

export interface Oidc {
  /** The provider's issuer, as its tokens name it. */
  readonly issuer: string;
  /** With `reauth`, the provider is asked to sign the person in again now. */
  start(options?: { reauth?: boolean }): Promise<{ url: string; pending: PendingLogin }>;
  /** callbackUrl is the full URL the provider redirected to, query included. */
  finish(callbackUrl: string, pending: PendingLogin): Promise<Identity>;
  /** Where to send the browser to sign out at the provider too; null when it offers no such page. */
  endSessionUrl(idTokenHint: string | undefined, postLogoutRedirectUri: string): string | null;
  /** Checks a back-channel logout token (signature, issuer, audience, event); throws when it does not check out. */
  verifyLogoutToken(token: string): Promise<LogoutNotice>;
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

/** The `identity` port: one provider, and how its sign-ins are admitted. */
export interface IdentityProvider {
  /** Resolved lazily: the provider may be unreachable when the server starts. */
  client(): Promise<Oidc>;
  redirectUri: string;
  /** The sign-in button. */
  displayName: string;
  rules: AccessRules;
  /** Create an account at first sign-in. */
  autoCreate: boolean;
  /** `amr` values every sign-in must carry (e.g. `["otp"]`); empty trusts the provider. */
  requireAmr?: readonly string[];
}
