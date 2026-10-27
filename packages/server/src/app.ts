import { createHash, timingSafeEqual } from "node:crypto";
import { evaluateOn, type Logger, PipelineDefError, pipelineDefFromComponents } from "@stardust/core";
import { getProject, listRuns, type Project, ProjectError, putProject, type Sql, startRun } from "@stardust/db";
import {
  type CompareResult,
  decideWebhook,
  POLICY,
  resolveChangedPaths,
  verifySignature,
} from "@stardust/plugin-source-github";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readBoundedBody } from "./body.ts";
import type { RunEvents } from "./events.ts";

export interface AppInfo {
  readonly version: string;
}

export interface Services {
  sql: Sql;
  /** Bearer token for the admin API until user sign-in exists. */
  adminToken: string;
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

const digest = (s: string) => createHash("sha256").update(s).digest();
function bearerMatches(header: string | undefined, token: string): boolean {
  const given = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return given !== "" && timingSafeEqual(digest(given), digest(token));
}

/** Builds the HTTP application. Without services, only /healthz exists. */
export function createApp(info: AppInfo, services?: Services): Hono {
  const app = new Hono();
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

  app.use("/api/v1/*", async (c, next) => {
    if (!bearerMatches(c.req.header("authorization"), services.adminToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  /** Lets a client check a token without side effects. */
  app.get("/api/v1/session", (c) => c.json({ ok: true }));

  app.put("/api/v1/projects/:id", async (c) => {
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
    if (!(await getProject(sql, c.req.param("id")))) return c.json({ error: "unknown project" }, 404);
    return c.json({ runs: await listRuns(sql, c.req.param("id")) });
  });

  // Server-sent events: a `runs-snapshot` first, then a `runs-delta` per changed
  // run, and a comment heartbeat every few seconds.
  app.get("/api/v1/projects/:id/events", async (c) => {
    const id = c.req.param("id");
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
