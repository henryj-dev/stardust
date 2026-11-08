import { type Action, can, type Logger, PipelineDefError, pipelineDefFromComponents } from "@stardust/core";
import {
  type AuditActor,
  type AuditInput,
  type AuditQuery,
  apiTokenFor,
  authenticate,
  createApiToken,
  createUser,
  getProject,
  latestRuns,
  listApiTokens,
  listAudit,
  listProjects,
  listRuns,
  listUsers,
  type Project,
  ProjectError,
  projectRole,
  putProject,
  recordAudit,
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
import type { BuildLogReader } from "@stardust/plugin-builder-buildkit";
import { type AccessRules, decideAccess, type Identity, type Oidc } from "@stardust/plugin-identity-oidc";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { RunEvents } from "./events.ts";
import { type PullTarget, type ResolvedTarget, TargetError } from "./source.ts";

export interface AppInfo {
  readonly version: string;
}

export interface Services {
  sql: Sql;
  /** The commit a manual run builds, from the source host. */
  resolveTarget: (repo: string, target: PullTarget) => Promise<ResolvedTarget>;
  /** Live run updates. Without it the events endpoint is not served. */
  events?: RunEvents;
  /** Build logs from the cluster. Without it the log endpoint says logs are not enabled. */
  buildLogs?: BuildLogReader;
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

  // Adds an audit event; also for requests that have no session yet (signing in).
  const auditAnonymous = async (c: Context, event: AuditInput) => {
    try {
      await recordAudit(sql, { ...clientOf(c), ...event });
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
      await auditAnonymous(c, {
        action: "auth.login.failed",
        actor: { kind: "anonymous", userId: null, name: result.knownUser ? body.username : null },
        detail: { via: "password", reason: result.reason },
      });
      return result.reason === "locked"
        ? c.json({ error: "too many failed attempts; try again later" }, 429)
        : c.json({ error: "invalid username or password" }, 401);
    }
    log.info("signed in", { username: result.user.username });
    await auditAnonymous(c, {
      action: "auth.login",
      actor: { kind: "user", userId: result.user.id, name: result.user.username },
      detail: { via: "password" },
    });
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
      await auditAnonymous(c, {
        action: "auth.login.failed",
        actor: { kind: "anonymous", userId: null, name: null },
        target: identity.subject,
        detail: { via: "oidc", reason: "group", issuer: identity.issuer },
      });
      return c.json({ error: "your account is not allowed to use stardust" }, 403);
    }
    const result = await signInWithIdentity(sql, identity, {
      autoCreate: oidc.autoCreate,
      isAdmin: oidc.rules.adminGroups ? access.isAdmin : null,
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
      detail: { via: "oidc", created: result.created },
    });
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

  /** Who is asking, as the audit log names them. */
  const actorOf = async (c: Context<Env>): Promise<AuditActor> => {
    const user = c.get("user");
    const token = await apiTokenFor(sql, c.get("token"));
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

  app.post("/api/v1/auth/logout", async (c) => {
    await signOut(sql, c.get("token"));
    await audit(c, { action: "auth.logout" });
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
      await audit(c, { action: "token.create", target: created.id, detail: { name, expiresInDays: days } });
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
      const user = await createUser(sql, {
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
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE username = ${c.req.param("username")}`;
    if (!user) return c.json({ error: "unknown user" }, 404);
    await setProjectRole(sql, c.req.param("id"), user.id, role);
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
    const existed = (await getProject(sql, project.id)) !== null;
    try {
      await putProject(sql, project);
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

  app.get("/api/v1/users", async (c) => {
    const denied = await deny(c, "admin");
    if (denied) return denied;
    return c.json({ users: await listUsers(sql) });
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
    const target = pullTarget(body ?? {});
    if (typeof target === "string") return c.json({ error: target }, 400);

    let resolved: ResolvedTarget;
    try {
      resolved = await services.resolveTarget(project.githubRepo, target);
    } catch (err) {
      if (err instanceof TargetError) return c.json({ error: err.message }, err.notFound ? 422 : 502);
      throw err;
    }
    const user = c.get("user");
    const runId = await startRun(sql, {
      projectId: project.id,
      event: "manual",
      trigger: "manual",
      ref: resolved.ref,
      sha: resolved.sha,
      def: project.pipelineDef ?? pipelineDefFromComponents(project.components),
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
    if (!reader) return c.json({ error: "build logs are not enabled on this server" }, 404);

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
      const finished = job.status !== "queued" && job.status !== "running";
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
