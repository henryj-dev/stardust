/**
 * Sign-in through any OpenID Connect provider: authorization code flow with
 * PKCE, a nonce, and a state that the caller must store and check once.
 *
 * This module only talks to the provider and checks what it returns
 * (signature, issuer, audience, expiry, nonce — done by openid-client). Who
 * the person is in stardust, and whether they may sign in, is the server's
 * decision from the claims returned here.
 */
import type { LogoutNotice, Oidc, PendingLogin } from "@stardust/core";
import { createRemoteJWKSet, jwtVerify } from "jose";
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
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  return {
    issuer: config.serverMetadata().issuer,
    async start(startOptions = {}) {
      const pending: PendingLogin = {
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier: client.randomPKCECodeVerifier(),
        ...(startOptions.reauth ? { reauth: true } : {}),
      };
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: options.redirectUri,
        scope,
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(pending.codeVerifier),
        code_challenge_method: "S256",
        // Confirming it is you: the provider signs the person in again, now.
        ...(startOptions.reauth ? { prompt: "login", max_age: "0" } : {}),
      });
      return { url: url.href, pending };
    },

    endSessionUrl(idTokenHint, postLogoutRedirectUri) {
      const endpoint = config.serverMetadata().end_session_endpoint;
      if (!endpoint) return null;
      const url = new URL(endpoint);
      if (idTokenHint) url.searchParams.set("id_token_hint", idTokenHint);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
      return url.href;
    },

    async verifyLogoutToken(token): Promise<LogoutNotice> {
      const jwksUri = config.serverMetadata().jwks_uri;
      if (!jwksUri) throw new Error("the provider publishes no keys");
      jwks ??= createRemoteJWKSet(new URL(jwksUri));
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.serverMetadata().issuer,
        audience: options.clientId,
        maxTokenAge: "5m",
      });
      // OpenID Connect Back-Channel Logout 1.0 §2.4: the event, no nonce, a subject or a session, an id.
      const events = payload.events as Record<string, unknown> | undefined;
      if (!events || typeof events["http://schemas.openid.net/event/backchannel-logout"] !== "object") {
        throw new Error("not a logout token");
      }
      if ("nonce" in payload) throw new Error("a logout token carries no nonce");
      const sid = typeof payload.sid === "string" ? payload.sid : null;
      const subject = typeof payload.sub === "string" ? payload.sub : null;
      if (!sid && !subject) throw new Error("a logout token names a subject or a session");
      if (typeof payload.jti !== "string") throw new Error("a logout token has an id");
      const exp = typeof payload.exp === "number" ? payload.exp : (payload.iat ?? 0) + 300;
      return { subject, sid, jti: payload.jti, expiresAt: new Date(exp * 1000) };
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
        sid: str(claims.sid),
        amr: Array.isArray(claims.amr) ? claims.amr.filter((a): a is string => typeof a === "string") : [],
        authTime: typeof claims.auth_time === "number" ? claims.auth_time : null,
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      };
    },
  };
}
