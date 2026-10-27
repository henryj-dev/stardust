import { type Action, can, evaluateOn, type Logger, PipelineDefError, pipelineDefFromComponents } from "@stardust/core";
import {
  authenticate,
  createApiToken,
  createUser,
  getProject,
  listApiTokens,
  listRuns,
  type Project,
  ProjectError,
  projectRole,
  putProject,
  revokeApiToken,
  type Sql,
  setProjectRole,
  signIn,
  signOut,
  startRun,
  type User,
} from "@stardust/db";
import {
  type CompareResult,
  decideWebhook,
  POLICY,
  resolveChangedPaths,
  verifySignature,
} from "@stardust/plugin-source-github";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readBoundedBody } from "./body.ts";
import type { RunEvents } from "./events.ts";

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
    const project = await getProject(sql, projectId);
    if (!project) {
      log.warn("webhook for an unknown project", { project: projectId, event, delivery });
      return c.json({ error: "unknown project" }, 404);
    }

    const read = await readBoundedBody(c.req.raw);
    if ("tooLarge" in read) {
      log.warn("webhook payload too large", { project: projectId, event, delivery });
      return c.json({ error: "payload too large" }, 413);
    }
    if (!verifySignature(read.body, c.req.header("x-hub-signature-256"), services.webhookSecret)) {
      log.warn("webhook signature rejected", { project: projectId, event, delivery });
      return c.json({ error: "invalid signature" }, 401);
    }
    if (event === "ping") return c.json({ pong: true });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(read.body) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }

    const decision = decideWebhook(event, payload, POLICY[project.webhookKind], project);
    if (decision.action === "ignore") {
      log.info("webhook ignored", { project: projectId, event, delivery, reason: decision.reason });
      return c.json({ ignored: true, reason: decision.reason }, 202);
    }

    const def = project.pipelineDef ?? pipelineDefFromComponents(project.components);
    const ctx = {
      ...(decision.branch !== undefined ? { branch: decision.branch } : {}),
      ...(decision.tag !== undefined ? { tag: decision.tag } : {}),
      ...(decision.baseBranch !== undefined ? { baseBranch: decision.baseBranch } : {}),
    };
    if (!evaluateOn(def, decision.event, ctx)) {
      const reason = `no trigger matches ${decision.event} ${decision.ref}`;
      log.info("webhook ignored", { project: projectId, event, delivery, reason });
      return c.json({ ignored: true, reason }, 202);
    }

    let changedPaths: string[] | null = null;
    if (decision.event === "push") {
      const repo = project.githubRepo;
      const resolved = await resolveChangedPaths({
        payload,
        compare: (base, head) =>
          repo ? services.compare(repo, base, head) : Promise.reject(new Error("project has no repository")),
      });
      changedPaths = resolved.paths;
      if (resolved.fallback) log.info("changed paths from the commits", { project: projectId, why: resolved.fallback });
    }

    const runId = await startRun(sql, {
      projectId: project.id,
      event: decision.event,
      trigger: decision.trigger,
      ref: decision.ref,
      sha: decision.sha,
      def,
      changedPaths,
    });
    log.info("run started", { project: projectId, event, delivery, run: runId, ref: decision.ref, sha: decision.sha });
    return c.json({ runId }, 201);
  });

  app.post("/api/v1/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
    if (typeof body?.username !== "string" || typeof body.password !== "string") {
      return c.json({ error: "username and password are required" }, 400);
    }
    const result = await signIn(sql, body.username, body.password);
    if (!result.ok) {
      log.warn("sign-in refused", { username: body.username, reason: result.reason });
      return result.reason === "locked"
        ? c.json({ error: "too many failed attempts; try again later" }, 429)
        : c.json({ error: "invalid username or password" }, 401);
    }
    log.info("signed in", { username: result.user.username });
    return c.json({ token: result.token, user: result.user });
  });

  // Every other /api/v1 route needs a session.
  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/auth/login") return next();
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
    } | null;
    if (typeof body?.username !== "string" || typeof body.password !== "string") {
      return c.json({ error: "username and password are required" }, 400);
    }
    try {
      const user = await createUser(sql, {
        username: body.username,
        password: body.password,
        isAdmin: body.isAdmin === true,
      });
      return c.json({ user }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
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
