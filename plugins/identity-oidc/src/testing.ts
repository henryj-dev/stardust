/**
 * A minimal OpenID provider for tests: discovery, JWKS and a token endpoint
 * that answers one authorization code with a signed ID token. Each knob
 * makes it misbehave in one way a real attacker or broken provider could.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface FakeProviderOptions {
  clientId: string;
  clientSecret: string;
}

export interface Issued {
  claims?: Record<string, unknown>;
  /** Overrides for the ID token's standard claims, to make it wrong. */
  tamper?: { aud?: string; iss?: string; nonce?: string; expired?: boolean; foreignKey?: boolean };
}

export class FakeProvider {
  readonly issuer: string;
  private readonly server: Server;
  private readonly codes = new Map<string, { nonce: string; challenge: string; issued: Issued }>();
  private readonly options: FakeProviderOptions;
  private readonly keys: { key: CryptoKey; jwk: Record<string, unknown> };
  private readonly foreign: CryptoKey;

  private constructor(
    server: Server,
    issuer: string,
    options: FakeProviderOptions,
    keys: { key: CryptoKey; jwk: Record<string, unknown> },
    foreign: CryptoKey,
  ) {
    this.server = server;
    this.issuer = issuer;
    this.options = options;
    this.keys = keys;
    this.foreign = foreign;
  }

  static async start(options: FakeProviderOptions): Promise<FakeProvider> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const provider = new FakeProvider(server, issuer, options, { key: privateKey, jwk }, other.privateKey);
    server.on("request", (req, res) => void provider.handle(req, res));
    return provider;
  }

  /** What the browser would get back from the provider after signing in at `authorizeUrl`. */
  approve(authorizeUrl: string, issued: Issued = {}): { code: string; state: string } {
    const url = new URL(authorizeUrl);
    const code = crypto.randomUUID();
    this.codes.set(code, {
      nonce: url.searchParams.get("nonce") ?? "",
      challenge: url.searchParams.get("code_challenge") ?? "",
      issued,
    });
    return { code, state: url.searchParams.get("state") ?? "" };
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (req.url === "/jwks") return json(200, { keys: [this.keys.jwk] });
    if (req.url === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const basic = Buffer.from(
        `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
      ).toString("base64");
      const authorised =
        req.headers.authorization === `Basic ${basic}` ||
        (form.get("client_id") === this.options.clientId && form.get("client_secret") === this.options.clientSecret);
      if (!authorised) return json(401, { error: "invalid_client" });
      const entry = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      if (!entry) return json(400, { error: "invalid_grant" });
      const verifier = form.get("code_verifier") ?? "";
      const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
        "base64url",
      );
      if (challenge !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE" });
      const t = entry.issued.tamper ?? {};
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ nonce: t.nonce ?? entry.nonce, ...entry.issued.claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(t.iss ?? this.issuer)
        .setAudience(t.aud ?? this.options.clientId)
        .setSubject(String(entry.issued.claims?.sub ?? "user-1"))
        .setIssuedAt(t.expired ? now - 7200 : now)
        .setExpirationTime(t.expired ? now - 3600 : now + 300)
        .sign(t.foreignKey ? this.foreign : this.keys.key);
      return json(200, { access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    json(404, { error: "not found" });
  }
}
