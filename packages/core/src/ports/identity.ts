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
}
