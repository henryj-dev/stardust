import { createHash, timingSafeEqual } from "node:crypto";
import { evaluateOn, PipelineDefError, pipelineDefFromComponents } from "@stardust/core";
import { getProject, listRuns, type Project, ProjectError, putProject, type Sql, startRun } from "@stardust/db";
import {
  type CompareResult,
  decideWebhook,
  POLICY,
  resolveChangedPaths,
  verifySignature,
} from "@stardust/plugin-source-github";
import { Hono } from "hono";
import { readBoundedBody } from "./body.ts";

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
}

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

  app.post("/webhooks/github/:project", async (c) => {
    const project = await getProject(sql, c.req.param("project"));
    if (!project) return c.json({ error: "unknown project" }, 404);

    const read = await readBoundedBody(c.req.raw);
    if ("tooLarge" in read) return c.json({ error: "payload too large" }, 413);
    if (!verifySignature(read.body, c.req.header("x-hub-signature-256"), services.webhookSecret)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    const event = c.req.header("x-github-event");
    if (event === "ping") return c.json({ pong: true });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(read.body) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }

    const decision = decideWebhook(event, payload, POLICY[project.webhookKind], project);
    if (decision.action === "ignore") return c.json({ ignored: true, reason: decision.reason }, 202);

    const def = project.pipelineDef ?? pipelineDefFromComponents(project.components);
    const ctx = {
      ...(decision.branch !== undefined ? { branch: decision.branch } : {}),
      ...(decision.tag !== undefined ? { tag: decision.tag } : {}),
      ...(decision.baseBranch !== undefined ? { baseBranch: decision.baseBranch } : {}),
    };
    if (!evaluateOn(def, decision.event, ctx)) {
      return c.json({ ignored: true, reason: `no trigger matches ${decision.event} ${decision.ref}` }, 202);
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
    return c.json({ runId }, 201);
  });

  app.use("/api/v1/*", async (c, next) => {
    if (!bearerMatches(c.req.header("authorization"), services.adminToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

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

  return app;
}
