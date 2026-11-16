import {
  type Action,
  type BuildLogReader,
  buildDecision,
  buildLogKey,
  bumpImage,
  can,
  commitWithCas,
  type DeployRepo,
  decideAccess,
  type Feature,
  type Identity,
  type IdentityProvider,
  type ImageNaming,
  type Logger,
  type LogoutNotice,
  manifestUsesImage,
  type ObjectStore,
  ownedElsewhere,
  ownerRegion,
  type PipelineDef,
  PipelineDefError,
  type PullTarget,
  pipelineDefFromComponents,
  type RepoAccess,
  type ResolvedTarget,
  removeResource,
  scaffoldComponent,
  TargetError,
  trustOf,
} from "@stardust/core";
import {
  API_TOKEN_PREFIX,
  type AuditActor,
  type AuditInput,
  type AuditQuery,
  apiTokenFor,
  authenticate,
  beginTotp,
  cancelJob,
  changePassword,
  checkPassword,
  checkSecondFactor,
  confirmTotp,
  createApiToken,
  createSession,
  createUser,
  deleteProject,
  endAllSessions,
  endChallenge,
  endOidcSessions,
  endSession,
  getAuditEvent,
  getProject,
  guardStore,
  issueAccountLink,
  latestRuns,
  listApiTokens,
  listAudit,
  listDeliveries,
  listProjects,
  listRuns,
  listSessions,
  listUsers,
  markReauthenticated,
  newRecoveryCodesFor,
  oidcLogoutHint,
  type Project,
  ProjectError,
  projectRole,
  putProject,
  recordAudit,
  removeTotp,
  revokeApiToken,
  type Sql,
  savePendingLogin,
  sessionFreshness,
  setProjectRole,
  signInWithIdentity,
  signOut,
  startChallenge,
  startRun,
  takeChallengeTry,
  takePendingLogin,
  totpStatus,
  type User,
  type UserChange,
  updateUser,
  useAccountLink,
} from "@stardust/db";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { changeEnv, checkChange, EnvConflict, type EnvEditor, EnvInputError, readEnv } from "./env.ts";
import type { RunEvents } from "./events.ts";
import { mountFeatures } from "./features.ts";

export interface AppInfo {
  readonly version: string;
}

export interface Services {
  /** This installation's region: projects it owns are changed here, others refused with their owner's name. */
  region?: string;
  /** External projects whose own code may be built (`jobs.upstreamBuilds`). */
  upstreamBuilds?: readonly string[];
  /** This region's database: runs and jobs, and reads of global tables that decide nothing about access. */
  sql: Sql;
  /**
   * The global database: accounts, sessions, roles, API tokens, projects and
   * the audit log are written here, and every decision about access reads
   * here. Without it, the regional database is also the global one.
   */
  globalSql?: Sql;
  /** The commit a manual run builds, from the source host. */
  resolveTarget: (repo: string, target: PullTarget) => Promise<ResolvedTarget>;
  /** Whether stardust can read a repository, and how. Without it the access check answers 404. */
  repoAccess?: (repo: string) => Promise<RepoAccess>;
  /** Live run updates. Without it the events endpoint is not served. */
  events?: RunEvents;
  /** Build logs from the cluster. Without it the log endpoint says logs are not enabled. */
  buildLogs?: BuildLogReader;
  /** Editing env and secrets in the deploy repository. Without it the env endpoints say it is off. */
  env?: EnvEditor;
  /** Sign-in through an OpenID provider. Without it only passwords work. */
  oidc?: IdentityProvider;
  /** How people sign in: local accounts and their second step, and how recent a sign-in must be. */
  auth?: AuthPolicy;
  /** Where a component's builds are pushed, for scaffolding its manifests. Optional. */
  images?: ImageNaming;
  /** Kept build logs, served once the cluster has cleaned a build up. Optional. */
  store?: ObjectStore;
  /** The deploy repository, for rolling a component back. Without it rollback answers 404. */
  deployRepo?: DeployRepo;
  /** Enabled plugins' routes and capabilities, mounted under /api/v1/plugins. */
  features?: readonly Feature[];
  /** Interval of SSE heartbeats, so proxies keep idle streams open. */
  heartbeatMs?: number;
  log?: Logger;
}

export interface AuthPolicy {
  /** Username-and-password sign-in. Off: single sign-on only (an operator can still reset a password on the host). */
  localEnabled: boolean;
  totp: "off" | "optional" | "required";
  /** Seals TOTP secrets in the database. */
  totpKey?: string;
  /** How recent a sign-in must be for actions that cannot be undone. */
  reauthMinutes: number;
  /** Shown in authenticator apps. */
  issuer: string;
}

const DEFAULT_AUTH: AuthPolicy = { localEnabled: true, totp: "optional", reauthMinutes: 10, issuer: "stardust" };

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

type Env = { Variables: { user: User; token: string } };

const bearer = (header: string | undefined) => (header?.startsWith("Bearer ") ? header.slice(7) : "");

/** Builds the HTTP application. Without services, only /healthz exists. */
export function createApp(info: AppInfo, services?: Services): Hono<Env> {
  const app = new Hono<Env>();
  app.get("/healthz", (c) => c.json({ status: "ok", version: info.version }));
  if (!services) return app;
  // Two handles (see Services.globalSql): accounts, sessions, roles and every
  // write to a global table use the global one; the rest read locally.
  const { sql } = services;
  const globalSql = services.globalSql ?? sql;
  const authPolicy = services.auth ?? DEFAULT_AUTH;
  const log = services.log ?? silent;

  // Adds an audit event; also for requests that have no session yet (signing in).
  const auditAnonymous = async (c: Context, event: AuditInput) => {
    try {
      await recordAudit(globalSql, { ...clientOf(c), ...event });
    } catch (err) {
      log.error("writing an audit event failed", { action: event.action, error: (err as Error).message });
    }
  };

  // API bodies are small.
  app.use(
    "/api/v1/*",
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }),
  );

  app.post("/api/v1/auth/login", async (c) => {
    if (!authPolicy.localEnabled) return c.json({ error: "password sign-in is off: use single sign-on" }, 403);
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
    if (typeof body?.username !== "string" || typeof body.password !== "string") {
      return c.json({ error: "username and password are required" }, 400);
    }
    const result = await checkPassword(globalSql, body.username, body.password);
    if (!result.ok) {
      // Only an existing username is logged: people type passwords into the username field.
      log.warn("sign-in refused", {
        username: result.knownUser ? body.username : "(not a user)",
        reason: result.reason,
      });
      await auditAnonymous(c, {
        action: "auth.login.failed",
        actor: { kind: "anonymous", userId: null, name: result.knownUser ? body.username : null },
        detail: { via: "password", reason: result.reason },
      });
      return result.reason === "locked"
        ? c.json({ error: "too many failed attempts; try again later" }, 429)
        : c.json({ error: "invalid username or password" }, 401);
    }
    // The password was right; with TOTP set up, the session waits for the code.
    if (authPolicy.totp !== "off" && (await totpStatus(globalSql, result.user.id)).enrolled) {
      return c.json({ secondFactor: "totp", challenge: await startChallenge(globalSql, result.user.id) });
    }
    const token = await createSession(globalSql, result.user.id, "password");
    log.info("signed in", { username: result.user.username });
    await auditAnonymous(c, {
      action: "auth.login",
      actor: { kind: "user", userId: result.user.id, name: result.user.username },
      detail: { via: "password" },
    });
    return c.json({ token, user: result.user });
  });

  // The second step: the challenge from the password step and a TOTP or recovery code.
  app.post("/api/v1/auth/login/totp", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { challenge?: unknown; code?: unknown } | null;
    if (typeof body?.challenge !== "string" || typeof body.code !== "string") {
      return c.json({ error: "challenge and code are required" }, 400);
    }
    const userId = await takeChallengeTry(globalSql, body.challenge);
    if (!userId) return c.json({ error: "this sign-in has expired; start again" }, 401);
    const kind = await checkSecondFactor(globalSql, userId, body.code, authPolicy.totpKey);
    const [user] = await globalSql<{ id: string; username: string; display_name: string; is_admin: boolean }[]>`
      SELECT id, username, display_name, is_admin FROM users WHERE id = ${userId} AND NOT disabled`;
    if (!kind || !user) {
      await auditAnonymous(c, {
        action: "auth.login.failed",
        actor: { kind: "anonymous", userId: null, name: user?.username ?? null },
        detail: { via: "password", reason: "second-factor" },
      });
      return c.json({ error: "that code is not right" }, 401);
    }
    await endChallenge(globalSql, body.challenge);
    const token = await createSession(globalSql, user.id, "password");
    await auditAnonymous(c, {
      action: "auth.login",
      actor: { kind: "user", userId: user.id, name: user.username },
      detail: { via: "password", secondFactor: kind },
    });
    return c.json({
      token,
      user: { id: user.id, username: user.username, displayName: user.display_name, isAdmin: user.is_admin },
    });
  });

  app.get("/api/v1/auth/methods", (c) =>
    c.json({ password: true, oidc: services.oidc ? { displayName: services.oidc.displayName } : null }),
  );

  // OpenID sign-in. The dashboard keeps `state` in a cookie of its own and
  // sends it back with the callback, which ties the callback to the browser
  // that started it (no login CSRF). The pending login is used once.
  app.post("/api/v1/auth/oidc/start", async (c) => {
    if (!services.oidc) return c.json({ error: "OpenID sign-in is not configured" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { reauth?: unknown } | null;
    const { url, pending } = await (await services.oidc.client()).start({ reauth: body?.reauth === true });
    await savePendingLogin(globalSql, pending);
    return c.json({ url, state: pending.state });
  });

  app.post("/api/v1/auth/oidc/callback", async (c) => {
    const oidc = services.oidc;
    if (!oidc) return c.json({ error: "OpenID sign-in is not configured" }, 404);
    const body = (await c.req.json().catch(() => null)) as { query?: unknown; state?: unknown } | null;
    if (typeof body?.query !== "string" || typeof body.state !== "string" || body.state === "") {
      return c.json({ error: "query and state are required" }, 400);
    }
    const query = new URLSearchParams(body.query);
    if (query.get("error")) {
      return c.json({ error: `the provider refused: ${query.get("error_description") ?? query.get("error")}` }, 401);
    }
    if (query.get("state") !== body.state) return c.json({ error: "this sign-in was not started here" }, 401);
    const pending = await takePendingLogin(globalSql, body.state);
    if (!pending) return c.json({ error: "this sign-in expired or was already used; start again" }, 401);
    let identity: Identity;
    try {
      identity = await (await oidc.client()).finish(`${oidc.redirectUri}?${query}`, pending);
    } catch (err) {
      log.warn("OpenID sign-in refused", { error: (err as Error).message });
      return c.json({ error: "the provider's answer did not check out" }, 401);
    }
    // A confirmation asked the provider to sign the person in again: it must have, just now.
    if (pending.reauth && (identity.authTime ?? 0) < Date.now() / 1000 - 300) {
      return c.json({ error: "the provider did not sign you in again; try once more" }, 401);
    }
    const missing = (oidc.requireAmr ?? []).filter((m) => !(identity.amr ?? []).includes(m));
    if (missing.length > 0) {
      await auditAnonymous(c, {
        action: "auth.login.failed",
        actor: { kind: "anonymous", userId: null, name: null },
        target: identity.subject,
        detail: { via: "oidc", reason: "amr", missing },
      });
      return c.json({ error: `your sign-in at the provider did not use: ${missing.join(", ")}` }, 403);
    }
    const access = decideAccess(identity, oidc.rules);
    if (!access.allowed) {
      log.warn("OpenID sign-in refused by group", { issuer: identity.issuer, subject: identity.subject });
      await auditAnonymous(c, {
        action: "auth.login.failed",
        actor: { kind: "anonymous", userId: null, name: null },
        target: identity.subject,
        detail: { via: "oidc", reason: "group", issuer: identity.issuer },
      });
      return c.json({ error: "your account is not allowed to use stardust" }, 403);
    }
    const result = await signInWithIdentity(globalSql, identity, {
      autoCreate: oidc.autoCreate,
      isAdmin: oidc.rules.adminGroups ? access.isAdmin : null,
      sid: identity.sid ?? null,
      ...(identity.idToken ? { idToken: identity.idToken } : {}),
    });
    if (!result.ok) {
      log.warn("OpenID sign-in refused", { subject: identity.subject, reason: result.reason });
      await auditAnonymous(c, {
        action: "auth.login.failed",
        actor: { kind: "anonymous", userId: null, name: null },
        target: identity.subject,
        detail: { via: "oidc", reason: result.reason, issuer: identity.issuer },
      });
      const message = {
        "no-account": "there is no stardust account for you; ask an administrator",
        disabled: "your account is disabled",
        "username-taken": "your username is taken by another account; ask an administrator",
        "no-username": "the provider sent no username or email",
      }[result.reason];
      return c.json({ error: message }, 403);
    }
    log.info("signed in", { username: result.user.username, via: "oidc", created: result.created });
    await auditAnonymous(c, {
      action: "auth.login",
      actor: { kind: "user", userId: result.user.id, name: result.user.username },
      detail: { via: "oidc", created: result.created, ...(pending.reauth ? { reauth: true } : {}) },
    });
    return c.json({ token: result.token, user: result.user });
  });

  // Every other /api/v1 route needs a session.
  // OpenID Connect Back-Channel Logout: the provider says a session ended
  // there, and stardust ends the matching ones. Public: the signed logout
  // token is the credential, and each token is accepted once.
  app.post("/api/v1/auth/oidc/backchannel-logout", async (c) => {
    const noStore = { "cache-control": "no-store" };
    const oidc = services.oidc;
    if (!oidc) return c.json({ error: "OpenID sign-in is not configured" }, 404, noStore);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = (form as Record<string, unknown>).logout_token;
    if (typeof token !== "string") return c.json({ error: "invalid_request" }, 400, noStore);
    let notice: LogoutNotice;
    try {
      notice = await (await oidc.client()).verifyLogoutToken(token);
    } catch (err) {
      log.warn("a back-channel logout token did not check out", { error: (err as Error).message });
      return c.json({ error: "invalid_request" }, 400, noStore);
    }
    if (!(await guardStore(globalSql).useOnce("oidc-logout", notice.jti, notice.expiresAt))) {
      return c.json({ error: "invalid_request" }, 400, noStore);
    }
    const issuer = (await oidc.client()).issuer;
    const ended = await endOidcSessions(globalSql, issuer, notice);
    await auditAnonymous(c, {
      action: "auth.logout.backchannel",
      actor: { kind: "system", userId: null, name: "identity provider" },
      ...(notice.subject ? { target: notice.subject } : {}),
      detail: { sessions: ended, bySession: notice.sid !== null },
    });
    return c.body(null, 200, noStore);
  });

  // Sets a password through a one-time link an administrator issued. Public:
  // the link is the credential. A used, expired or unknown link is the same 400.
  app.post("/api/v1/auth/link", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown; password?: unknown } | null;
    if (typeof body?.token !== "string" || typeof body.password !== "string") {
      return c.json({ error: "token and password are required" }, 400);
    }
    const result = await useAccountLink(globalSql, body.token, body.password);
    if (!result.ok) {
      return result.reason === "weak"
        ? c.json({ error: "passwords must be 12 to 1024 characters" }, 400)
        : c.json({ error: "this link is not valid: it was used, it expired, or it was replaced by a newer one" }, 400);
    }
    await auditAnonymous(c, {
      action: result.purpose === "invite" ? "account.invite.accept" : "account.reset",
      actor: { kind: "anonymous", userId: null, name: result.username },
      target: result.username,
    });
    return c.json({ username: result.username });
  });

  const PUBLIC_PATHS = new Set([
    "/api/v1/auth/login",
    "/api/v1/auth/methods",
    "/api/v1/auth/oidc/start",
    "/api/v1/auth/oidc/callback",
    "/api/v1/auth/link",
    "/api/v1/auth/login/totp",
    "/api/v1/auth/oidc/backchannel-logout",
  ]);
  app.use("/api/v1/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();

    const token = bearer(c.req.header("authorization"));
    const user = token ? await authenticate(globalSql, token) : null;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    c.set("token", token);
    // With TOTP required, a password session without it may only set it up (or leave).
    if (authPolicy.totp === "required" && !token.startsWith(API_TOKEN_PREFIX) && !SETUP_PATHS.test(c.req.path)) {
      const fresh = await sessionFreshness(globalSql, token);
      if (fresh?.via === "password" && !(await totpStatus(globalSql, user.id)).enrolled) {
        return c.json({ error: "set up two-step sign-in first", totpSetupRequired: true }, 403);
      }
    }
    await next();
  });

  // A project another region owns is changed there: refuse, and say where.
  const PROJECT_WRITE = /^\/api\/v1\/(?:projects|plugins\/[^/]+\/projects)\/([^/]+)(?:\/|$)/;
  app.use("/api/v1/*", async (c, next) => {
    const method = c.req.method;
    const id = PROJECT_WRITE.exec(c.req.path)?.[1];
    if (method === "GET" || method === "HEAD" || !id || !services.region) return next();
    const project = await getProject(globalSql, decodeURIComponent(id));
    const owner = ownedElsewhere(project?.metadata, services.region);
    if (owner)
      return c.json({ error: `project ${id} belongs to region ${owner}: change it there`, region: owner }, 409);
    await next();
  });

  /**
   * Null when the session proved its sign-in recently enough for an action
   * that cannot be undone; otherwise the 401 to send. API tokens pass: they
   * are credentials made for automation, not a browser left open.
   */
  const requireFresh = async (c: Context<Env>): Promise<Response | null> => {
    const token = c.get("token");
    if (token.startsWith(API_TOKEN_PREFIX)) return null;
    const fresh = await sessionFreshness(globalSql, token);
    if (fresh && fresh.ageSeconds <= authPolicy.reauthMinutes * 60) return null;
    return c.json({ error: "confirm it is you first", reauthRequired: true, via: fresh?.via ?? "password" }, 401);
  };

  /** Null when allowed; otherwise the response to send. Unreadable projects are 404, not 403. */
  const deny = async (c: Context<Env>, action: Action, projectId?: string): Promise<Response | null> => {
    const user = c.get("user");
    const role = projectId ? await projectRole(globalSql, user.id, projectId) : null;
    if (can(user, action, role)) return null;
    if (projectId && !can(user, "project:read", role)) return c.json({ error: "unknown project" }, 404);
    return c.json({ error: "forbidden" }, 403);
  };

  /** Who is asking, as the audit log names them. */
  const actorOf = async (c: Context<Env>): Promise<AuditActor> => {
    const user = c.get("user");
    const token = await apiTokenFor(globalSql, c.get("token"));
    return token
      ? { kind: "token", userId: user.id, name: user.username, tokenId: token.id }
      : { kind: "user", userId: user.id, name: user.username };
  };

  /**
   * Adds an audit event for a signed-in caller. The change it records has
   * already happened, so a failure here is logged loudly, not returned.
   */
  const audit = async (c: Context<Env>, event: Omit<AuditInput, "actor"> & { actor?: AuditActor }) => {
    await auditAnonymous(c, { ...event, actor: event.actor ?? (await actorOf(c)) });
  };

  app.get("/api/v1/session", (c) => c.json({ user: c.get("user") }));

  // Two-step sign-in for one's own local account.
  const localSession = async (c: Context<Env>): Promise<Response | null> => {
    if (authPolicy.totp === "off") return c.json({ error: "two-step sign-in is off on this server" }, 404);
    if (c.get("token").startsWith(API_TOKEN_PREFIX)) return c.json({ error: "use a session, not an API token" }, 403);
    const fresh = await sessionFreshness(globalSql, c.get("token"));
    if (fresh?.via !== "password") {
      return c.json({ error: "this session is from single sign-on: its second step is the provider's" }, 409);
    }
    return null;
  };

  app.get("/api/v1/account/totp", async (c) =>
    c.json({ policy: authPolicy.totp, ...(await totpStatus(globalSql, c.get("user").id)) }),
  );

  app.post("/api/v1/account/totp/setup", async (c) => {
    const refused = await localSession(c);
    if (refused) return refused;
    const user = c.get("user");
    const begun = await beginTotp(globalSql, user.id, user.username, authPolicy.issuer, authPolicy.totpKey);
    if (!begun) return c.json({ error: "two-step sign-in is set up already: turn it off first to start again" }, 409);
    // The secret is in this answer only, for the authenticator app.
    return c.json(begun);
  });

  app.post("/api/v1/account/totp/confirm", async (c) => {
    const refused = await localSession(c);
    if (refused) return refused;
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    if (typeof body?.code !== "string") return c.json({ error: "code is required" }, 400);
    const codes = await confirmTotp(globalSql, c.get("user").id, body.code, authPolicy.totpKey);
    if (!codes) return c.json({ error: "that code is not right, or there is nothing to confirm" }, 400);
    await markReauthenticated(globalSql, c.get("token"));
    await audit(c, { action: "account.totp.on", target: c.get("user").username });
    return c.json({ recoveryCodes: codes });
  });

  app.post("/api/v1/account/totp/recovery-codes", async (c) => {
    const refused = await localSession(c);
    if (refused) return refused;
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    const user = c.get("user");
    if (
      typeof body?.code !== "string" ||
      (await checkSecondFactor(globalSql, user.id, body.code, authPolicy.totpKey)) !== "totp"
    ) {
      return c.json({ error: "a current code from your app is required" }, 403);
    }
    const codes = await newRecoveryCodesFor(globalSql, user.id);
    await audit(c, { action: "account.totp.recovery-codes", target: user.username });
    return c.json({ recoveryCodes: codes });
  });

  app.delete("/api/v1/account/totp", async (c) => {
    const refused = await localSession(c);
    if (refused) return refused;
    if (authPolicy.totp === "required") return c.json({ error: "two-step sign-in is required on this server" }, 409);
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    const user = c.get("user");
    if (
      typeof body?.code !== "string" ||
      !(await checkSecondFactor(globalSql, user.id, body.code, authPolicy.totpKey))
    ) {
      return c.json({ error: "a current code (or a recovery code) is required" }, 403);
    }
    await removeTotp(globalSql, user.id);
    await audit(c, { action: "account.totp.off", target: user.username });
    return c.json({ ok: true });
  });

  // Proving the sign-in again, before an action that cannot be undone. A
  // password session answers with its code (or its password without TOTP);
  // a single sign-on session signs in again at the provider.
  app.post("/api/v1/account/reauth", async (c) => {
    const user = c.get("user");
    const fresh = await sessionFreshness(globalSql, c.get("token"));
    if (!fresh) return c.json({ error: "use a session, not an API token" }, 403);
    if (fresh.via === "oidc") return c.json({ error: "sign in again through single sign-on", via: "oidc" }, 409);
    const body = (await c.req.json().catch(() => null)) as { code?: unknown; password?: unknown } | null;
    const enrolled = authPolicy.totp !== "off" && (await totpStatus(globalSql, user.id)).enrolled;
    const ok = enrolled
      ? typeof body?.code === "string" &&
        (await checkSecondFactor(globalSql, user.id, body.code, authPolicy.totpKey)) !== null
      : typeof body?.password === "string" && (await checkPassword(globalSql, user.username, body.password)).ok;
    if (!ok)
      return c.json(
        {
          error: enrolled ? "that code is not right" : "that password is not right",
          needs: enrolled ? "code" : "password",
        },
        403,
      );
    await markReauthenticated(globalSql, c.get("token"));
    await audit(c, { action: "account.reauth", target: user.username });
    return c.json({ ok: true });
  });

  // One's own account: password and sessions.
  app.post("/api/v1/account/password", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { current?: unknown; password?: unknown } | null;
    if (typeof body?.current !== "string" || typeof body.password !== "string") {
      return c.json({ error: "current and password are required" }, 400);
    }
    if (c.get("token").startsWith(API_TOKEN_PREFIX))
      return c.json({ error: "change a password from a session, not with an API token" }, 403);
    const result = await changePassword(globalSql, c.get("user").id, c.get("token"), body.current, body.password);
    if (!result.ok) {
      const [status, error] = {
        "wrong-password": [403, "the current password is wrong"],
        weak: [400, "passwords must be 12 to 1024 characters"],
        "no-password": [409, "this account signs in through single sign-on and has no password"],
      }[result.reason] as [400 | 403 | 409, string];
      return c.json({ error }, status);
    }
    await audit(c, { action: "account.password", target: c.get("user").username });
    return c.json({ ok: true });
  });

  app.get("/api/v1/account/sessions", async (c) =>
    c.json({ sessions: await listSessions(globalSql, c.get("user").id, c.get("token")) }),
  );

  app.delete("/api/v1/account/sessions/:sessionId", async (c) => {
    const id = c.req.param("sessionId");
    if (!UUID.test(id) || !(await endSession(globalSql, c.get("user").id, id)))
      return c.json({ error: "unknown session" }, 404);
    await audit(c, { action: "account.session.end", target: id });
    return c.json({ ok: true });
  });

  // An administrator: a one-time link for someone to set their password, or ending everything that acts as them.
  app.post("/api/v1/users/:username/links", async (c) => {
    const denied = (await deny(c, "admin")) ?? (await requireFresh(c));
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as { purpose?: unknown } | null;
    if (body?.purpose !== "invite" && body?.purpose !== "reset")
      return c.json({ error: "purpose must be invite or reset" }, 400);
    const username = c.req.param("username");
    const result = await issueAccountLink(globalSql, username, body.purpose, c.get("user").username);
    if ("error" in result) {
      const [status, error] = {
        "unknown-user": [404, "unknown user, or disabled"],
        "not-local": [409, "this account signs in through single sign-on"],
        "has-password": [409, "this account has a password already: issue a reset link"],
        "no-password": [409, "this account has no password yet: issue an invitation"],
      }[result.error] as [404 | 409, string];
      return c.json({ error }, status);
    }
    await audit(c, {
      action: `user.link.${body.purpose}`,
      target: username,
      detail: { expiresAt: result.expiresAt.toISOString() },
    });
    // The token is in the answer only: the person who asked hands the link on.
    return c.json(
      { token: result.token, path: `/account/link/${result.token}`, expiresAt: result.expiresAt.toISOString() },
      201,
    );
  });

  // After a lost phone: an administrator turns the person's TOTP off; they set it up again.
  app.delete("/api/v1/users/:username/totp", async (c) => {
    const denied = (await deny(c, "admin")) ?? (await requireFresh(c));
    if (denied) return denied;
    const username = c.req.param("username");
    const [user] = await globalSql<{ id: string }[]>`SELECT id FROM users WHERE username = ${username}`;
    if (!user || !(await removeTotp(globalSql, user.id)))
      return c.json({ error: "this user has no two-step sign-in" }, 404);
    await audit(c, { action: "user.totp.reset", target: username });
    return c.json({ ok: true });
  });

  app.post("/api/v1/users/:username/sessions/end", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const username = c.req.param("username");
    const ended = await endAllSessions(globalSql, username);
    if (!ended) return c.json({ error: "unknown user" }, 404);
    await audit(c, { action: "user.sessions.end", target: username, detail: ended });
    return c.json(ended);
  });

  mountFeatures(app, services.features ?? [], {
    audit,
    roleIn: (userId, projectId) => projectRole(globalSql, userId, projectId),
    log,
    requireFresh,
  });

  app.post("/api/v1/auth/logout", async (c) => {
    // A single sign-on session also ends at the provider, when it has a page for that.
    const hint = services.oidc ? await oidcLogoutHint(globalSql, c.get("token")) : null;
    await signOut(globalSql, c.get("token"));
    await audit(c, { action: "auth.logout" });
    if (hint !== null && services.oidc) {
      const back = services.oidc.redirectUri.replace(/\/login\/oidc\/callback$/, "/login");
      const redirect = (await services.oidc.client().catch(() => null))?.endSessionUrl(hint, back) ?? null;
      if (redirect) return c.json({ ok: true, redirect });
    }
    return c.json({ ok: true });
  });

  // Users manage their own API tokens; a token acts with its user's roles.
  app.get("/api/v1/tokens", async (c) => c.json({ tokens: await listApiTokens(globalSql, c.get("user").id) }));

  // A new token passes the fresh sign-in check itself, so making one needs a fresh sign-in.
  app.post("/api/v1/tokens", async (c) => {
    const stale = await requireFresh(c);
    if (stale) return stale;
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; expiresInDays?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const days = body?.expiresInDays ?? null;
    if (!name || name.length > 100) return c.json({ error: "name is required (at most 100 characters)" }, 400);
    if (days !== null && !(Number.isInteger(days) && (days as number) >= 1 && (days as number) <= 3650)) {
      return c.json({ error: "expiresInDays must be a whole number of days from 1 to 3650, or null" }, 400);
    }
    try {
      const created = await createApiToken(globalSql, c.get("user").id, name, days as number | null);
      log.info("API token created", { username: c.get("user").username, name });
      await audit(c, { action: "token.create", target: created.id, detail: { name, expiresInDays: days } });
      return c.json(created, 201);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return c.json({ error: `a token named "${name}" exists` }, 409);
      throw err;
    }
  });

  app.delete("/api/v1/tokens/:tokenId", async (c) => {
    if (!(await revokeApiToken(globalSql, c.get("user").id, c.req.param("tokenId")))) {
      return c.json({ error: "unknown token" }, 404);
    }
    await audit(c, { action: "token.revoke", target: c.req.param("tokenId") });
    return c.json({ ok: true });
  });

  app.post("/api/v1/users", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as {
      username?: unknown;
      password?: unknown;
      isAdmin?: unknown;
      oidc?: { issuer?: unknown; subject?: unknown };
    } | null;
    const oidc =
      typeof body?.oidc?.issuer === "string" && typeof body.oidc.subject === "string"
        ? { issuer: body.oidc.issuer, subject: body.oidc.subject }
        : undefined;
    if (typeof body?.username !== "string" || (typeof body.password !== "string" && !oidc)) {
      return c.json({ error: "username and a password or an oidc identity are required" }, 400);
    }
    try {
      const user = await createUser(globalSql, {
        username: body.username,
        ...(typeof body.password === "string" ? { password: body.password } : {}),
        ...(oidc ? { oidc } : {}),
        isAdmin: body.isAdmin === true,
      });
      await audit(c, {
        action: "user.create",
        target: user.username,
        detail: { isAdmin: user.isAdmin, withPassword: typeof body.password === "string", oidc: Boolean(oidc) },
      });
      return c.json({ user }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch("/api/v1/users/:username", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "a JSON object is required" }, 400);
    const change: UserChange = {};
    for (const key of Object.keys(body)) {
      if (!["isAdmin", "disabled", "displayName", "oidc"].includes(key))
        return c.json({ error: `unknown field "${key}"` }, 400);
    }
    if (body.isAdmin !== undefined) {
      if (typeof body.isAdmin !== "boolean") return c.json({ error: "isAdmin must be true or false" }, 400);
      change.isAdmin = body.isAdmin;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") return c.json({ error: "disabled must be true or false" }, 400);
      change.disabled = body.disabled;
    }
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== "string" || body.displayName.length > 200)
        return c.json({ error: "displayName must be text of at most 200 characters" }, 400);
      change.displayName = body.displayName;
    }
    if (body.oidc !== undefined) {
      const o = body.oidc as { issuer?: unknown; subject?: unknown } | null;
      if (o === null) change.oidc = null;
      else if (typeof o?.issuer === "string" && o.issuer !== "" && typeof o.subject === "string" && o.subject !== "")
        change.oidc = { issuer: o.issuer, subject: o.subject };
      else return c.json({ error: "oidc must be {issuer, subject} or null" }, 400);
    }
    const result = await updateUser(globalSql, c.req.param("username"), change);
    if (!result.ok) {
      const [status, error] = {
        "unknown-user": [404, "unknown user"],
        "last-admin": [409, "this would leave no enabled administrator"],
        "identity-taken": [409, "that OpenID identity belongs to another user"],
      }[result.reason] as [404 | 409, string];
      return c.json({ error }, status);
    }
    log.info("user changed", {
      username: c.req.param("username"),
      by: c.get("user").username,
      fields: Object.keys(change),
    });
    await audit(c, {
      action: "user.update",
      target: c.req.param("username"),
      detail: {
        fields: Object.keys(change),
        ...(change.isAdmin !== undefined ? { isAdmin: change.isAdmin } : {}),
        ...(change.disabled !== undefined ? { disabled: change.disabled } : {}),
      },
    });
    return c.json({ ok: true });
  });

  app.put("/api/v1/projects/:id/members/:username", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as { role?: unknown } | null;
    const role = body?.role;
    if (role !== "maintainer" && role !== "viewer" && role !== null) {
      return c.json({ error: "role must be maintainer, viewer or null" }, 400);
    }
    if (!(await getProject(sql, c.req.param("id")))) return c.json({ error: "unknown project" }, 404);
    const [user] = await globalSql<{ id: string }[]>`SELECT id FROM users WHERE username = ${c.req.param("username")}`;
    if (!user) return c.json({ error: "unknown user" }, 404);
    await setProjectRole(globalSql, c.req.param("id"), user.id, role);
    await audit(c, {
      action: "project.member.set",
      projectId: c.req.param("id"),
      target: c.req.param("username"),
      detail: { role },
    });
    return c.json({ ok: true });
  });

  app.put("/api/v1/projects/:id", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    let body: Partial<Project>;
    try {
      body = (await c.req.json()) as Partial<Project>;
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }
    const project: Project = {
      id: c.req.param("id"),
      name: body.name ?? c.req.param("id"),
      githubRepo: body.githubRepo ?? null,
      pipelineDef: body.pipelineDef ?? null,
      components: body.components ?? [],
      metadata: body.metadata ?? {},
    };
    const before = await getProject(globalSql, project.id);
    const existed = before !== null;
    // A project belongs to the region it is made in, and keeps its owner when edited.
    const owner = ownerRegion(project.metadata) ?? ownerRegion(before?.metadata) ?? services.region;
    if (owner) project.metadata = { ...project.metadata, region: owner };
    try {
      await putProject(globalSql, project);
    } catch (err) {
      if (err instanceof ProjectError || err instanceof PipelineDefError) return c.json({ error: err.message }, 400);
      throw err;
    }
    await audit(c, {
      action: existed ? "project.update" : "project.create",
      projectId: project.id,
      target: project.id,
      detail: {
        githubRepo: project.githubRepo,
        components: project.components.map((x) => x.name),
        pipelineDef: project.pipelineDef !== null,
      },
    });
    return c.json(await getProject(sql, project.id));
  });

  /** The components a definition builds whose deploy directory has no manifest using their image. */
  const undeliverable = async (project: Project, def: PipelineDef) => {
    const repo = services.deployRepo?.repo;
    if (!repo) return [];
    const head = await repo.headSha();
    const named = new Set<string>();
    for (const job of Object.values(def.jobs)) {
      if (job.pipeline !== "C" && job.pipeline !== "N") continue;
      const name = job.component ?? (project.components.length === 1 ? project.components[0]?.name : undefined);
      if (name) named.add(name);
    }
    const out: Array<{ component: string; deployDir: string }> = [];
    for (const component of project.components.filter((c) => named.has(c.name))) {
      const files = new Map<string, string>();
      for (const name of await repo.listDir(component.deployDir, head)) {
        const file = await repo.readFile(`${component.deployDir}/${name}`, head);
        if (file) files.set(`${component.deployDir}/${name}`, file.content);
      }
      if (!manifestUsesImage(files, project.id, component.name)) {
        out.push({ component: component.name, deployDir: component.deployDir });
      }
    }
    return out;
  };

  // Adds or replaces one component of a project, leaving the others as they are.
  app.put("/api/v1/projects/:id/components/:name", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const project = await getProject(sql, c.req.param("id"));
    if (!project) return c.json({ error: "unknown project" }, 404);
    const body = (await c.req.json().catch(() => null)) as Partial<Project["components"][number]> | null;
    if (!body || typeof body !== "object") return c.json({ error: "body is not JSON" }, 400);
    const component = { ...body, name: c.req.param("name") } as Project["components"][number];
    const existed = project.components.some((x) => x.name === component.name);
    const components = existed
      ? project.components.map((x) => (x.name === component.name ? component : x))
      : [...project.components, component];
    try {
      await putProject(globalSql, { ...project, components });
    } catch (err) {
      if (err instanceof ProjectError || err instanceof PipelineDefError) return c.json({ error: err.message }, 400);
      throw err;
    }
    await audit(c, {
      action: existed ? "project.component.update" : "project.component.create",
      projectId: project.id,
      target: component.name,
      detail: { pipeline: component.pipeline, deployDir: component.deployDir },
    });
    return c.json(await getProject(sql, project.id));
  });

  app.delete("/api/v1/projects/:id/components/:name", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const project = await getProject(sql, c.req.param("id"));
    if (!project) return c.json({ error: "unknown project" }, 404);
    const name = c.req.param("name");
    if (!project.components.some((x) => x.name === name)) return c.json({ error: "unknown component" }, 404);
    try {
      await putProject(globalSql, { ...project, components: project.components.filter((x) => x.name !== name) });
    } catch (err) {
      if (err instanceof ProjectError || err instanceof PipelineDefError) return c.json({ error: err.message }, 400);
      throw err;
    }
    await audit(c, { action: "project.component.delete", projectId: project.id, target: name });
    return c.json({ ok: true });
  });

  // Writes a minimal set of manifests into a component's empty deploy
  // directory, so its first delivery has an image to point at.
  // Whether stardust can read a repository, before a project names it: public,
  // through the GitHub App (and how widely it is installed), with the token, or not at all.
  app.get("/api/v1/source/access", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const repo = c.req.query("repo") ?? "";
    // Each half a GitHub name, never "." or ".." (which would walk the API's paths).
    const halves = repo.split("/");
    if (halves.length !== 2 || halves.some((h) => !/^[A-Za-z0-9_.-]+$/.test(h) || /^\.+$/.test(h))) {
      return c.json({ error: "repo must be owner/name" }, 400);
    }
    if (!services.repoAccess) return c.json({ error: "the source host cannot say who reads a repository" }, 404);
    try {
      return c.json({ repo, ...(await services.repoAccess(repo)) });
    } catch (err) {
      return c.json({ error: `source host: ${(err as Error).message}` }, 502);
    }
  });

  app.post("/api/v1/projects/:id/components/:name/scaffold", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const project = await getProject(sql, c.req.param("id"));
    const component = project?.components.find((x) => x.name === c.req.param("name"));
    if (!project || !component) return c.json({ error: "unknown component" }, 404);
    const repo = services.deployRepo?.repo;
    if (!repo || !services.images) {
      return c.json(
        { error: "scaffolding needs a deploy repository (gitops-git) and a builder (builder-buildkit)" },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { namespace?: unknown; port?: unknown } | null;
    if (typeof body?.namespace !== "string") return c.json({ error: "namespace is required" }, 400);
    if (body.port !== undefined && typeof body.port !== "number")
      return c.json({ error: "port must be a number" }, 400);
    let files: Map<string, string>;
    try {
      files = scaffoldComponent({
        project: project.id,
        component: component.name,
        namespace: body.namespace,
        imageRepository: services.images.repository(project.id, component.name),
        ...(typeof body.port === "number" ? { port: body.port } : {}),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    let occupied = false;
    const result = await commitWithCas(repo, async (_head, at) => {
      occupied = (await at.list(component.deployDir)).length > 0;
      if (occupied) return null;
      return {
        files: new Map([...files].map(([name, text]) => [`${component.deployDir}/${name}`, text])),
        message: `chore(${project.id}/${component.name}): scaffold manifests`,
      };
    });
    if (occupied)
      return c.json({ error: `${component.deployDir} is not empty; stardust does not overwrite manifests` }, 409);
    if (result.status === "error") return c.json({ error: `deploy repository: ${result.message}` }, 502);
    const deployCommit = result.status === "committed" ? result.sha : null;
    await audit(c, {
      action: "project.component.scaffold",
      projectId: project.id,
      target: component.name,
      detail: { deployDir: component.deployDir, files: [...files.keys()], deployCommit },
    });
    return c.json({ deployCommit, files: [...files.keys()].map((f) => `${component.deployDir}/${f}`) }, 201);
  });

  // Deletes a project with its runs and memberships (the audit log keeps
  // its history). With `withdraw`, its components' manifests are removed
  // from the deploy repository first, in one commit, so the GitOps
  // controller prunes what they deployed. The body must repeat the id.
  app.delete("/api/v1/projects/:id", async (c) => {
    const denied = (await deny(c, "admin")) ?? (await requireFresh(c));
    if (denied) return denied;
    const project = await getProject(sql, c.req.param("id"));
    if (!project) return c.json({ error: "unknown project" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown; withdraw?: unknown } | null;
    if (body?.confirm !== project.id)
      return c.json({ error: `repeat the project's id as "confirm" to delete it` }, 400);
    let deployCommit: string | null = null;
    if (body.withdraw === true) {
      const repo = services.deployRepo?.repo;
      if (!repo) return c.json({ error: "withdrawing needs a deploy repository (gitops-git)" }, 404);
      const result = await commitWithCas(repo, async (_head, at) => {
        const files = new Map<string, string | null>();
        for (const component of project.components) {
          for (const name of await at.list(component.deployDir)) files.set(`${component.deployDir}/${name}`, null);
          // Drop the directory from every kustomization above it that lists it, by its path from there.
          const parts = component.deployDir.split("/");
          for (let depth = parts.length - 1; depth >= 0; depth--) {
            const dir = parts.slice(0, depth).join("/");
            const entry = parts.slice(depth).join("/");
            for (const k of ["kustomization.yaml", "kustomization.yml"]) {
              const path = dir ? `${dir}/${k}` : k;
              const file = files.has(path) ? { content: files.get(path) ?? "" } : await at.read(path);
              if (!file) continue;
              const next = removeResource(file.content, entry);
              if (next !== file.content) files.set(path, next);
            }
          }
        }
        return files.size === 0 ? null : { files, message: `chore(${project.id}): withdraw manifests` };
      });
      if (result.status === "error") return c.json({ error: `deploy repository: ${result.message}` }, 502);
      if (result.status === "committed") deployCommit = result.sha;
    }
    await deleteProject(globalSql, project.id);
    await audit(c, {
      action: "project.delete",
      projectId: project.id,
      target: project.id,
      detail: { withdrawn: body.withdraw === true, deployCommit, components: project.components.map((x) => x.name) },
    });
    return c.json({ ok: true, deployCommit });
  });

  // Projects the caller may read: all of them for administrators, else their
  // memberships. Each carries its newest run (`lastRun`, without jobs) so a list
  // can show how every project's latest delivery went in one request.
  app.get("/api/v1/projects", async (c) => {
    const user = c.get("user");
    const projects = await listProjects(sql, user.isAdmin ? undefined : user.id);
    const last = await latestRuns(
      sql,
      projects.map((p) => p.id),
    );
    return c.json({ projects: projects.map((p) => ({ ...p, lastRun: last.get(p.id) ?? null })) });
  });

  app.get("/api/v1/projects/:id", async (c) => {
    const denied = await deny(c, "project:read", c.req.param("id"));
    if (denied) return denied;
    const project = await getProject(sql, c.req.param("id"));
    return project ? c.json(project) : c.json({ error: "unknown project" }, 404);
  });

  // The audit log. Administrators read all of it; a project's maintainers
  // read that project's events (viewers do not: it says who changed what).
  app.get("/api/v1/audit", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const query = auditQuery(c.req.query());
    if (typeof query === "string") return c.json({ error: query }, 400);
    return c.json(await listAudit(sql, query));
  });

  app.get("/api/v1/audit/:eventId", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    const event = await getAuditEvent(sql, c.req.param("eventId"));
    return event ? c.json(event) : c.json({ error: "unknown event" }, 404);
  });

  app.get("/api/v1/projects/:id/audit", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:write", id);
    if (denied) return denied;
    if (!(await getProject(sql, id))) return c.json({ error: "unknown project" }, 404);
    const params = c.req.query();
    if (params.project !== undefined) return c.json({ error: 'unknown parameter "project"' }, 400);
    const query = auditQuery(params);
    if (typeof query === "string") return c.json({ error: query }, 400);
    return c.json(await listAudit(sql, { ...query, projectId: id }));
  });

  // A project's environment. Readers see plain values and the names of
  // secrets; secret values are write-only. Maintainers change one layer at a
  // time, against the revision they read.
  app.get("/api/v1/projects/:id/env", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:read", id);
    if (denied) return denied;
    const project = await getProject(sql, id);
    if (!project) return c.json({ error: "unknown project" }, 404);
    if (!services.env) return c.json({ error: "editing env is not enabled on this server" }, 404);
    try {
      const { layers } = await readEnv(services.env, project);
      const role = await projectRole(globalSql, c.get("user").id, id);
      return c.json({ layers, canEdit: can(c.get("user"), "project:write", role) });
    } catch (err) {
      log.warn("reading env failed", { project: id, error: (err as Error).message });
      return c.json({ error: "the deploy repository could not be read" }, 502);
    }
  });

  app.patch("/api/v1/projects/:id/env/:layer", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:write", id);
    if (denied) return denied;
    const project = await getProject(sql, id);
    if (!project) return c.json({ error: "unknown project" }, 404);
    if (!services.env) return c.json({ error: "editing env is not enabled on this server" }, 404);
    const layer = c.req.param("layer");
    let change: ReturnType<typeof checkChange>;
    try {
      change = checkChange(await c.req.json().catch(() => null));
    } catch (err) {
      if (err instanceof EnvInputError) return c.json({ error: err.message }, 400);
      throw err;
    }
    const by = c.get("user").username;
    try {
      const result = await changeEnv(services.env, project, layer, change, by);
      const keys = (o?: Record<string, string>) => Object.keys(o ?? {});
      if (result.status === "committed") {
        log.info("env changed", { project: id, layer, commit: result.commit, by });
        await audit(c, {
          action: "env.change",
          projectId: id,
          target: layer,
          detail: {
            set: keys(change.set),
            unset: change.unset ?? [],
            secretsSet: keys(change.setSecrets),
            secretsUnset: change.unsetSecrets ?? [],
            commit: result.commit,
          },
        });
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof EnvInputError) return c.json({ error: err.message }, 400);
      if (err instanceof EnvConflict) return c.json({ error: err.message }, 409);
      // The message may quote git or sops; it is logged, not returned.
      log.error("changing env failed", { project: id, layer, error: (err as Error).message });
      return c.json({ error: "the deploy repository could not be changed" }, 502);
    }
  });

  app.get("/api/v1/users", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    return c.json({ users: await listUsers(globalSql) });
  });

  // A run: someone with write access asks for a commit to be built and
  // delivered. It is the only way a run starts — stardust takes no webhooks, so
  // a merge to a public repository never deploys by itself. The definition's
  // `on` block and path filters do not apply: the person asking has chosen the
  // commit, and every job runs.
  app.post("/api/v1/projects/:id/runs", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:write", id);
    if (denied) return denied;
    const project = await getProject(sql, id);
    if (!project) return c.json({ error: "unknown project" }, 404);
    if (!project.githubRepo) return c.json({ error: "the project has no repository to build from" }, 409);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const asked = pullTarget(body ?? {});
    if (typeof asked === "string") return c.json({ error: asked }, 400);
    const trust = trustOf(project.metadata);
    // A pinned project runs its pin unless asked for something else (which the check below refuses).
    const target = trust.pin && Object.keys(asked).length === 0 ? { sha: trust.pin } : asked;
    const def = project.pipelineDef ?? pipelineDefFromComponents(project.components);
    // A build whose image no manifest uses cannot be delivered: say so before building.
    const missing = await undeliverable(project, def);
    if (missing.length > 0) {
      return c.json(
        {
          error: `${missing.map((m) => `${m.component} (${m.deployDir})`).join(", ")}: no manifest there uses the component's image; add one, or scaffold it, before building`,
          components: missing.map((m) => m.component),
        },
        409,
      );
    }

    let resolved: ResolvedTarget;
    try {
      resolved = await services.resolveTarget(project.githubRepo, target);
    } catch (err) {
      if (err instanceof TargetError) return c.json({ error: err.message }, err.notFound ? 422 : 502);
      throw err;
    }
    // Someone else's code: refused here, before anything is queued, as the worker would.
    for (const job of Object.values(def.jobs)) {
      const decision = buildDecision(
        trust,
        { projectId: project.id, pipeline: job.pipeline, sha: resolved.sha },
        services.upstreamBuilds ?? [],
      );
      if (!decision.ok) return c.json({ error: decision.reason }, 409);
    }
    const user = c.get("user");
    const runId = await startRun(sql, {
      projectId: project.id,
      event: "manual",
      trigger: "manual",
      ref: resolved.ref,
      sha: resolved.sha,
      def,
      changedPaths: null,
      requestedBy: user.username,
    });
    log.info("run started", {
      project: id,
      event: "manual",
      run: runId,
      ref: resolved.ref,
      sha: resolved.sha,
      by: user.username,
    });
    await audit(c, {
      action: "run.start",
      projectId: project.id,
      target: runId,
      detail: { ref: resolved.ref, sha: resolved.sha },
    });
    return c.json({ runId, ref: resolved.ref, sha: resolved.sha }, 201);
  });

  app.get("/api/v1/projects/:id/runs", async (c) => {
    const denied = await deny(c, "project:read", c.req.param("id"));
    if (denied) return denied;
    if (!(await getProject(sql, c.req.param("id")))) return c.json({ error: "unknown project" }, 404);
    return c.json({ runs: await listRuns(sql, c.req.param("id")) });
  });

  // One run of a project, with its jobs. A run of another project is unknown here.
  const findRun = async (projectId: string, runId: string) =>
    UUID.test(runId) ? ((await listRuns(sql, projectId, 1, runId))[0] ?? null) : null;

  app.get("/api/v1/projects/:id/runs/:runId", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:read", id);
    if (denied) return denied;
    if (!(await getProject(sql, id))) return c.json({ error: "unknown project" }, 404);
    const run = await findRun(id, c.req.param("runId"));
    return run ? c.json(run) : c.json({ error: "unknown run" }, 404);
  });

  // Cancels a job that has not finished. A running build is stopped: its
  // worker loses the lease at the next renewal and deletes the build Job.
  app.post("/api/v1/projects/:id/runs/:runId/jobs/:job/cancel", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:write", id);
    if (denied) return denied;
    if (!(await getProject(sql, id))) return c.json({ error: "unknown project" }, 404);
    const run = await findRun(id, c.req.param("runId"));
    if (!run) return c.json({ error: "unknown run" }, 404);
    const job = c.req.param("job");
    if (!run.jobs.some((j) => j.name === job)) return c.json({ error: "unknown job" }, 404);
    if (!(await cancelJob(sql, run.id, job))) return c.json({ error: "the job has already finished" }, 409);
    await audit(c, { action: "run.job.cancel", projectId: id, target: `${run.id}/${job}` });
    return c.json({ ok: true });
  });

  // What was delivered for a component, newest first: what a rollback can return to.
  app.get("/api/v1/projects/:id/components/:name/deliveries", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:read", id);
    if (denied) return denied;
    const project = await getProject(sql, id);
    const component = project?.components.find((x) => x.name === c.req.param("name"));
    if (!project || !component) return c.json({ error: "unknown component" }, 404);
    return c.json({
      deliveries: await listDeliveries(sql, id, component.name, project.components.length === 1),
    });
  });

  // Points a component back at an image it was delivered with before: the one
  // before the latest delivery, or the delivery `job` names. One commit to the
  // deploy repository, like a delivery; Flux rolls it out.
  app.post("/api/v1/projects/:id/components/:name/rollback", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:write", id);
    if (denied) return denied;
    const project = await getProject(sql, id);
    const component = project?.components.find((x) => x.name === c.req.param("name"));
    if (!project || !component) return c.json({ error: "unknown component" }, 404);
    const deployRepo = services.deployRepo;
    if (!deployRepo) return c.json({ error: "rolling back needs a deploy repository (gitops-git)" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { job?: unknown } | null;
    if (body?.job !== undefined && typeof body.job !== "string") return c.json({ error: "job must be a job id" }, 400);
    const deliveries = await listDeliveries(sql, id, component.name, project.components.length === 1);
    const latest = deliveries[0];
    const target =
      typeof body?.job === "string"
        ? deliveries.find((d) => d.jobId === body.job)
        : deliveries.find((d) => d.digest !== latest?.digest);
    if (!target) {
      return c.json(
        {
          error:
            typeof body?.job === "string" ? "no delivery of this component has that job" : "nothing to roll back to",
        },
        409,
      );
    }
    const result = await bumpImage(deployRepo.repo, {
      dir: component.deployDir,
      project: project.id,
      component: component.name,
      sha: target.sha,
      digest: target.digest,
      buildRev: target.jobId,
      ...(deployRepo.buildRevAnnotation ? { buildRevAnnotation: deployRepo.buildRevAnnotation } : {}),
    });
    if (result.status === "error") return c.json({ error: `deploy repository: ${result.message}` }, 502);
    await audit(c, {
      action: "project.rollback",
      projectId: id,
      target: component.name,
      detail: { toJob: target.jobId, sha: target.sha, deployCommit: result.status === "committed" ? result.sha : null },
    });
    return c.json({
      status: result.status === "committed" ? "committed" : "up-to-date",
      deployCommit: result.status === "committed" ? result.sha : null,
      sha: target.sha,
      digest: target.digest,
      job: target.jobId,
    });
  });

  // A job's build log, as plain text, read from the build pod while the
  // cluster keeps it. `?follow=true` keeps the response open while the build
  // prints. 409: the build has not started printing yet, ask again shortly.
  // 410: the pod is gone, and stardust keeps no copy of the log.
  app.get("/api/v1/projects/:id/runs/:runId/jobs/:job/log", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:read", id);
    if (denied) return denied;
    if (!(await getProject(sql, id))) return c.json({ error: "unknown project" }, 404);
    const run = await findRun(id, c.req.param("runId"));
    if (!run) return c.json({ error: "unknown run" }, 404);
    const job = run.jobs.find((j) => j.name === c.req.param("job"));
    if (!job) return c.json({ error: "unknown job" }, 404);
    const reader = services.buildLogs;
    const finished = job.status !== "queued" && job.status !== "running";
    // The copy kept when the build finished, for when its pod is gone.
    const kept = async (): Promise<Response | null> => {
      if (!finished || !services.store) return null;
      const body = await services.store.get(buildLogKey(id, run.id, job.name)).catch((err: Error) => {
        log.warn("reading a kept build log failed", { project: id, run: run.id, job: job.name, error: err.message });
        return null;
      });
      return body
        ? new Response(body, {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-content-type-options": "nosniff",
              "cache-control": "no-store",
              "x-stardust-log": "kept",
            },
          })
        : null;
    };
    if (!reader) return (await kept()) ?? c.json({ error: "build logs are not enabled on this server" }, 404);

    // Ends the cluster request when the client goes away.
    const upstream = new AbortController();
    const stop = () => upstream.abort();
    const clientSignal = c.req.raw.signal;
    clientSignal.addEventListener("abort", stop, { once: true });
    const release = () => clientSignal.removeEventListener("abort", stop);
    let found: Awaited<ReturnType<BuildLogReader>>;
    try {
      found = await reader({
        runId: run.id,
        jobName: job.name,
        follow: c.req.query("follow") === "true",
        signal: upstream.signal,
      });
    } catch (err) {
      release();
      log.warn("reading a build log failed", {
        project: id,
        run: run.id,
        job: job.name,
        error: (err as Error).message,
      });
      return c.json({ error: "the build log could not be read from the cluster" }, 502);
    }
    if (found.state !== "open") {
      release();
      if (found.state === "none" && finished) {
        const copy = await kept();
        if (copy) return copy;
      }
      if (found.state === "none" && finished)
        return c.json({ error: "this build's log is no longer available: the cluster has cleaned up the build" }, 410);
      return c.json({ error: "the build has not started printing yet" }, 409);
    }
    const body = found.body;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of body) controller.enqueue(chunk);
        } catch {
          // The client left, or the cluster ended the stream: end the response either way.
        } finally {
          release();
          try {
            controller.close();
          } catch {
            // Already cancelled.
          }
        }
      },
      cancel: stop,
    });
    return new Response(stream, {
      headers: {
        // Text, never HTML: the log is shown as it was printed.
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });

  // Server-sent events: a `runs-snapshot` first, then a `runs-delta` per changed
  // run, and a comment heartbeat every few seconds.
  app.get("/api/v1/projects/:id/events", async (c) => {
    const id = c.req.param("id");
    const denied = await deny(c, "project:read", id);
    if (denied) return denied;
    const events = services.events;
    if (!events) return c.json({ error: "live updates are not enabled" }, 404);
    if (!(await getProject(sql, id))) return c.json({ error: "unknown project" }, 404);
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = events.subscribe(id, (run) => {
        queue.push(JSON.stringify(run));
        wake?.();
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: "runs-snapshot", data: JSON.stringify(await listRuns(sql, id)) });
      while (!stream.aborted) {
        const next = queue.shift();
        if (next !== undefined) {
          await stream.writeSSE({ event: "runs-delta", data: next });
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, services.heartbeatMs ?? 5_000);
        });
        wake = null;
        if (queue.length === 0 && !stream.aborted) await stream.write(": heartbeat\n\n");
      }
      unsubscribe();
    });
  });

  return app;
}

/**
 * Where a request came from, for the audit log: the peer address the server
 * saw, and what the client says (the dashboard passes on the browser's).
 */
function clientOf(c: Context): Pick<AuditInput, "ip" | "forwardedFor" | "userAgent"> {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return {
    ip: incoming?.socket?.remoteAddress ?? null,
    forwardedFor: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

const AUDIT_FILTER = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** An audit query from URL parameters, or why they are wrong. */
export function auditQuery(params: Record<string, string>): AuditQuery | string {
  const known = ["actor", "action", "project", "since", "until", "before", "limit"];
  const unknown = Object.keys(params).find((k) => !known.includes(k));
  if (unknown) return `unknown parameter "${unknown}"`;
  const q: AuditQuery = {};
  if (params.actor !== undefined) {
    if (params.actor.length === 0 || params.actor.length > 200) return "actor must be a name";
    q.actor = params.actor;
  }
  if (params.action !== undefined) {
    if (!AUDIT_FILTER.test(params.action)) return "action must be an action name or a dotted prefix of one";
    q.action = params.action.replace(/\.$/, "");
  }
  if (params.project !== undefined) {
    if (!AUDIT_FILTER.test(params.project)) return "project must be a project id";
    q.projectId = params.project;
  }
  for (const key of ["since", "until"] as const) {
    const v = params[key];
    if (v === undefined) continue;
    if (Number.isNaN(Date.parse(v))) return `${key} must be a date and time`;
    q[key] = new Date(v).toISOString();
  }
  if (params.before !== undefined) {
    if (!/^[1-9][0-9]{0,18}$/.test(params.before)) return "before must be the cursor from a previous page";
    q.before = params.before;
  }
  if (params.limit !== undefined) {
    const n = Number(params.limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) return "limit must be a whole number from 1 to 200";
    q.limit = n;
  }
  return q;
}

// A git ref name as people type it: no leading dash or slash, no "..", no
// characters git refuses or a URL would need escaping for.
const REF_NAME = /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** What a password session without TOTP may still do where TOTP is required. */
const SETUP_PATHS = /^\/api\/v1\/(session|auth\/logout|account\/totp(\/setup|\/confirm)?)$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The target of a manual run from its request body, or why the body is wrong. */
export function pullTarget(body: Record<string, unknown>): PullTarget | string {
  const given = (["branch", "tag", "sha"] as const).filter((k) => body[k] !== undefined);
  const unknown = Object.keys(body).filter((k) => !["branch", "tag", "sha"].includes(k));
  if (unknown.length > 0) return `unknown field "${unknown[0]}"; give one of branch, tag or sha`;
  if (given.length > 1) return "give at most one of branch, tag or sha";
  const key = given[0];
  if (key === undefined) return {};
  const value = body[key];
  if (key === "sha") {
    return typeof value === "string" && COMMIT.test(value)
      ? { sha: value }
      : "sha must be a full 40-character commit hash";
  }
  if (typeof value !== "string" || !REF_NAME.test(value)) return `${key} is not a valid ref name`;
  return key === "branch" ? { branch: value } : { tag: value };
}
