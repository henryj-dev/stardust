import {
  type Action,
  can,
  type Logger,
  loadPipelineDef,
  type PipelineDef,
  PipelineDefError,
  planRun,
} from "@stardust/core";
import {
  authenticate,
  claimDelivery,
  createApiToken,
  createUser,
  getProject,
  listApiTokens,
  listProjects,
  listRuns,
  listUsers,
  type Project,
  ProjectError,
  projectRole,
  putProject,
  releaseDelivery,
  revokeApiToken,
  type Sql,
  savePendingLogin,
  setProjectRole,
  signIn,
  signInWithIdentity,
  signOut,
  startRun,
  takePendingLogin,
  type User,
  type UserChange,
  updateUser,
} from "@stardust/db";
import { type AccessRules, decideAccess, type Identity, type Oidc } from "@stardust/plugin-identity-oidc";
import { type CompareResult, verifySignature } from "@stardust/plugin-source-github";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { readBoundedBody } from "./body.ts";
import type { RunEvents } from "./events.ts";
import { planDelivery } from "./plan-delivery.ts";

export interface AppInfo {
  readonly version: string;
}

export interface Services {
  sql: Sql;
  webhookSecret: string;
  /** Net change of a push, from the source host's compare API. */
  compare: (repo: string, base: string, head: string) => Promise<CompareResult>;
  /** Live run updates. Without it the events endpoint is not served. */
  events?: RunEvents;
  /** Sign-in through an OpenID provider. Without it only passwords work. */
  oidc?: {
    /** Resolved lazily: the provider may be unreachable when the server starts. */
    client: () => Promise<Oidc>;
    redirectUri: string;
    displayName: string;
    rules: AccessRules;
    autoCreate: boolean;
  };
  /** Interval of SSE heartbeats, so proxies keep idle streams open. */
  heartbeatMs?: number;
  log?: Logger;
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

type Env = { Variables: { user: User; token: string } };

const bearer = (header: string | undefined) => (header?.startsWith("Bearer ") ? header.slice(7) : "");

/** Builds the HTTP application. Without services, only /healthz exists. */
export function createApp(info: AppInfo, services?: Services): Hono<Env> {
  const app = new Hono<Env>();
  app.get("/healthz", (c) => c.json({ status: "ok", version: info.version }));
  if (!services) return app;
  const { sql } = services;
  const log = services.log ?? silent;

  app.post("/webhooks/github/:project", async (c) => {
    const projectId = c.req.param("project");
    const event = c.req.header("x-github-event");
    const delivery = c.req.header("x-github-delivery");
    // The signature first: an unsigned caller learns nothing, not even which projects exist.
    const read = await readBoundedBody(c.req.raw);
    if ("tooLarge" in read) {
      log.warn("webhook payload too large", { project: projectId, event, delivery });
      return c.json({ error: "payload too large" }, 413);
    }
    if (!verifySignature(read.body, c.req.header("x-hub-signature-256"), services.webhookSecret)) {
      log.warn("webhook signature rejected", { project: projectId, event, delivery });
      return c.json({ error: "invalid signature" }, 401);
    }
    const project = await getProject(sql, projectId);
    if (!project) {
      log.warn("webhook for an unknown project", { project: projectId, event, delivery });
      return c.json({ error: "unknown project" }, 404);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(read.body) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }

    // A ping starts nothing; organisation webhooks send it without a repository.
    if (event === "ping") return c.json({ pong: true });

    // The secret is shared by every webhook, so a signature only proves the
    // sender holds it. The delivery must also be about this project's repository:
    // otherwise any repository with a stardust webhook could aim at any project.
    const from = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
    if (project.githubRepo && (typeof from !== "string" || from.toLowerCase() !== project.githubRepo.toLowerCase())) {
      log.warn("webhook from another repository", { project: projectId, event, delivery, repository: from });
      return c.json({ error: "this delivery is not for the project's repository" }, 403);
    }

    const plan = await planDelivery({ project, event, payload, compare: services.compare });
    if (plan.action === "ignore") {
      log.info("webhook ignored", { project: projectId, event, delivery, reason: plan.reason });
      return c.json({ ignored: true, reason: plan.reason }, 202);
    }
    if (plan.fallback) log.info("changed paths from the commits", { project: projectId, why: plan.fallback });

    // A re-sent copy of a delivery that already started a run starts nothing.
    if (delivery && !(await claimDelivery(sql, delivery, project.id))) {
      log.info("webhook ignored", { project: projectId, event, delivery, reason: "duplicate delivery" });
      return c.json({ ignored: true, reason: "duplicate delivery" }, 202);
    }
    let runId: string;
    try {
      runId = await startRun(sql, {
        projectId: project.id,
        event: plan.event,
        trigger: plan.trigger,
        ref: plan.ref,
        sha: plan.sha,
        def: plan.def,
        changedPaths: plan.changedPaths,
      });
    } catch (err) {
      if (delivery) await releaseDelivery(sql, delivery);
      throw err;
    }
    log.info("run started", { project: projectId, event, delivery, run: runId, ref: plan.ref, sha: plan.sha });
    return c.json({ runId }, 201);
  });

  // API bodies are small; the webhook has its own, larger bound.
  // The plan endpoint takes a whole webhook payload and bounds it like the webhook does.
  const smallBodies = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: "request body too large" }, 413),
  });
  app.use("/api/v1/*", (c, next) => (c.req.path.endsWith("/plan") ? next() : smallBodies(c, next)));

  app.post("/api/v1/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
    if (typeof body?.username !== "string" || typeof body.password !== "string") {
      return c.json({ error: "username and password are required" }, 400);
    }
    const result = await signIn(sql, body.username, body.password);
    if (!result.ok) {
      // Only an existing username is logged: people type passwords into the username field.
      log.warn("sign-in refused", {
        username: result.knownUser ? body.username : "(not a user)",
        reason: result.reason,
      });
      return result.reason === "locked"
        ? c.json({ error: "too many failed attempts; try again later" }, 429)
        : c.json({ error: "invalid username or password" }, 401);
    }
    log.info("signed in", { username: result.user.username });
    return c.json({ token: result.token, user: result.user });
  });

  app.get("/api/v1/auth/methods", (c) =>
    c.json({ password: true, oidc: services.oidc ? { displayName: services.oidc.displayName } : null }),
  );

  // OpenID sign-in. The dashboard keeps `state` in a cookie of its own and
  // sends it back with the callback, which ties the callback to the browser
  // that started it (no login CSRF). The pending login is used once.
  app.post("/api/v1/auth/oidc/start", async (c) => {
    if (!services.oidc) return c.json({ error: "OpenID sign-in is not configured" }, 404);
    const { url, pending } = await (await services.oidc.client()).start();
    await savePendingLogin(sql, pending);
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
    const pending = await takePendingLogin(sql, body.state);
    if (!pending) return c.json({ error: "this sign-in expired or was already used; start again" }, 401);
    let identity: Identity;
    try {
      identity = await (await oidc.client()).finish(`${oidc.redirectUri}?${query}`, pending);
    } catch (err) {
      log.warn("OpenID sign-in refused", { error: (err as Error).message });
      return c.json({ error: "the provider's answer did not check out" }, 401);
    }
    const access = decideAccess(identity, oidc.rules);
    if (!access.allowed) {
      log.warn("OpenID sign-in refused by group", { issuer: identity.issuer, subject: identity.subject });
      return c.json({ error: "your account is not allowed to use stardust" }, 403);
    }
    const result = await signInWithIdentity(sql, identity, {
      autoCreate: oidc.autoCreate,
      isAdmin: oidc.rules.adminGroups ? access.isAdmin : null,
    });
    if (!result.ok) {
      log.warn("OpenID sign-in refused", { subject: identity.subject, reason: result.reason });
      const message = {
        "no-account": "there is no stardust account for you; ask an administrator",
        disabled: "your account is disabled",
        "username-taken": "your username is taken by another account; ask an administrator",
        "no-username": "the provider sent no username or email",
      }[result.reason];
      return c.json({ error: message }, 403);
    }
    log.info("signed in", { username: result.user.username, via: "oidc", created: result.created });
    return c.json({ token: result.token, user: result.user });
  });

  // Every other /api/v1 route needs a session.
  const PUBLIC_PATHS = new Set([
    "/api/v1/auth/login",
    "/api/v1/auth/methods",
    "/api/v1/auth/oidc/start",
    "/api/v1/auth/oidc/callback",
  ]);
  app.use("/api/v1/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();

    const token = bearer(c.req.header("authorization"));
    const user = token ? await authenticate(sql, token) : null;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    c.set("token", token);
    await next();
  });

  /** Null when allowed; otherwise the response to send. Unreadable projects are 404, not 403. */
  const deny = async (c: Context<Env>, action: Action, projectId?: string): Promise<Response | null> => {
    const user = c.get("user");
    const role = projectId ? await projectRole(sql, user.id, projectId) : null;
    if (can(user, action, role)) return null;
    if (projectId && !can(user, "project:read", role)) return c.json({ error: "unknown project" }, 404);
    return c.json({ error: "forbidden" }, 403);
  };

  app.get("/api/v1/session", (c) => c.json({ user: c.get("user") }));

  app.post("/api/v1/auth/logout", async (c) => {
    await signOut(sql, c.get("token"));
    return c.json({ ok: true });
  });

  // Users manage their own API tokens; a token acts with its user's roles.
  app.get("/api/v1/tokens", async (c) => c.json({ tokens: await listApiTokens(sql, c.get("user").id) }));

  app.post("/api/v1/tokens", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; expiresInDays?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const days = body?.expiresInDays ?? null;
    if (!name || name.length > 100) return c.json({ error: "name is required (at most 100 characters)" }, 400);
    if (days !== null && !(Number.isInteger(days) && (days as number) >= 1 && (days as number) <= 3650)) {
      return c.json({ error: "expiresInDays must be a whole number of days from 1 to 3650, or null" }, 400);
    }
    try {
      const created = await createApiToken(sql, c.get("user").id, name, days as number | null);
      log.info("API token created", { username: c.get("user").username, name });
      return c.json(created, 201);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return c.json({ error: `a token named "${name}" exists` }, 409);
      throw err;
    }
  });

  app.delete("/api/v1/tokens/:tokenId", async (c) => {
    if (!(await revokeApiToken(sql, c.get("user").id, c.req.param("tokenId")))) {
      return c.json({ error: "unknown token" }, 404);
    }
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
      const user = await createUser(sql, {
        username: body.username,
        ...(typeof body.password === "string" ? { password: body.password } : {}),
        ...(oidc ? { oidc } : {}),
        isAdmin: body.isAdmin === true,
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
    const result = await updateUser(sql, c.req.param("username"), change);
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
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE username = ${c.req.param("username")}`;
    if (!user) return c.json({ error: "unknown user" }, 404);
    await setProjectRole(sql, c.req.param("id"), user.id, role);
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
      webhookKind: body.webhookKind ?? "repo",
    };
    try {
      await putProject(sql, project);
    } catch (err) {
      if (err instanceof ProjectError || err instanceof PipelineDefError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json(await getProject(sql, project.id));
  });

  // Projects the caller may read: all of them for administrators, else their memberships.
  app.get("/api/v1/projects", async (c) => {
    const user = c.get("user");
    return c.json({ projects: await listProjects(sql, user.isAdmin ? undefined : user.id) });
  });

  app.get("/api/v1/projects/:id", async (c) => {
    const denied = await deny(c, "project:read", c.req.param("id"));
    if (denied) return denied;
    const project = await getProject(sql, c.req.param("id"));
    return project ? c.json(project) : c.json({ error: "unknown project" }, 404);
  });

  app.get("/api/v1/users", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    return c.json({ users: await listUsers(sql) });
  });

  // What a delivery would do, without doing it: the same decision as the webhook
  // (policy, triggers, changed paths) and the fate of every job, assuming each
  // job that runs succeeds. Nothing is written. For shadow-running a new
  // installation next to an existing one, and for checking a pipeline definition.
  app.post("/api/v1/projects/:id/plan", async (c) => {
    const denied = await deny(c, "project:write", c.req.param("id"));
    if (denied) return denied;
    const project = await getProject(sql, c.req.param("id"));
    if (!project) return c.json({ error: "unknown project" }, 404);
    const read = await readBoundedBody(c.req.raw);
    if ("tooLarge" in read) return c.json({ error: "request body too large" }, 413);
    let body: { event?: unknown; payload?: unknown; changedPaths?: unknown };
    try {
      body = JSON.parse(read.body) as typeof body;
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }
    if (typeof body.event !== "string" || typeof body.payload !== "object" || body.payload === null) {
      return c.json({ error: "event and payload are required" }, 400);
    }
    const cp = body.changedPaths;
    if (cp !== undefined && cp !== null && !(Array.isArray(cp) && cp.every((p) => typeof p === "string"))) {
      return c.json({ error: "changedPaths must be a list of paths, or null" }, 400);
    }
    const plan = await planDelivery({
      project,
      event: body.event,
      payload: body.payload as Record<string, unknown>,
      compare: services.compare,
      ...(cp !== undefined ? { changedPaths: cp as string[] | null } : {}),
    });
    if (plan.action === "ignore") return c.json(plan);
    let def: PipelineDef;
    try {
      def = loadPipelineDef(plan.def);
    } catch (err) {
      if (err instanceof PipelineDefError) return c.json({ error: err.message }, 422);
      throw err;
    }
    const { def: _def, ...rest } = plan;
    return c.json({ ...rest, jobs: planRun(def, plan.event, plan.changedPaths) });
  });

  app.get("/api/v1/projects/:id/runs", async (c) => {
    const denied = await deny(c, "project:read", c.req.param("id"));
    if (denied) return denied;
    if (!(await getProject(sql, c.req.param("id")))) return c.json({ error: "unknown project" }, 404);
    return c.json({ runs: await listRuns(sql, c.req.param("id")) });
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
