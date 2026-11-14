/**
 * Plugin routes under /api/v1/plugins/<plugin>, behind the same sign-in as
 * every other API route. Each route's permission is checked before the
 * plugin sees the request, and each change is audited with the route's
 * action. The plugin never sees the request object itself.
 */
import type { Feature, Logger, Method, ProjectRole, RouteResponse } from "@stardust/core";
import { can, mayUse } from "@stardust/core";
import type { AuditInput, User } from "@stardust/db";
import type { Context, Hono } from "hono";

type Env = { Variables: { user: User; token: string } };

export interface MountOptions {
  audit: (c: Context<Env>, event: Omit<AuditInput, "actor">) => Promise<void>;
  /** The caller's role in a project, for per-project permissions. */
  roleIn: (userId: string, projectId: string) => Promise<ProjectRole | null>;
  log: Logger;
}

const METHODS: Record<Method, "get" | "post" | "put" | "patch" | "delete"> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
};

export function mountFeatures(app: Hono<Env>, features: readonly Feature[], options: MountOptions): void {
  app.get("/api/v1/capabilities", (c) =>
    c.json({ plugins: features.map((f) => ({ name: f.plugin, capabilities: f.capabilities })) }),
  );

  for (const feature of features) {
    const permissions = new Map(feature.permissions.map((p) => [p.id, p]));
    for (const route of feature.routes) {
      const path = `/api/v1/plugins/${feature.plugin}${route.path}`;
      app[METHODS[route.method]](path, async (c) => {
        const user = c.get("user");
        const permission = permissions.get(route.permission);
        const projectId = c.req.param("project");
        const role =
          permission?.grantedTo.startsWith("project-") && projectId ? await options.roleIn(user.id, projectId) : null;
        if (!mayUse(user, permission, role)) {
          // A project the caller cannot read is unknown to them, as everywhere else.
          if (projectId && permission?.grantedTo.startsWith("project-") && !can(user, "project:read", role)) {
            return c.json({ error: "unknown project" }, 404);
          }
          return c.json({ error: "forbidden" }, 403);
        }
        let body: unknown = null;
        if (route.method !== "GET" && route.method !== "DELETE") {
          const text = await c.req.text();
          if (text !== "") {
            try {
              body = JSON.parse(text);
            } catch {
              return c.json({ error: "the body must be JSON" }, 400);
            }
          }
        }
        let response: RouteResponse;
        try {
          response = await route.handle({
            params: c.req.param() as Record<string, string>,
            query: new URL(c.req.url).searchParams,
            body,
            user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
            signal: c.req.raw.signal,
          });
        } catch (err) {
          options.log.error("a plugin route failed", {
            plugin: feature.plugin,
            route: `${route.method} ${route.path}`,
            error: (err as Error).message,
          });
          return c.json({ error: "internal error" }, 500);
        }
        if (route.method !== "GET" && response.status < 400 && route.audit) {
          await options.audit(c, {
            action: route.audit,
            ...(response.audit?.projectId ? { projectId: response.audit.projectId } : {}),
            ...(response.audit?.target ? { target: response.audit.target } : {}),
            ...(response.audit?.detail ? { detail: response.audit.detail } : {}),
          });
        }
        if (response.status === 204 || response.body === undefined) return c.body(null, response.status as 204);
        return c.json(response.body as object, response.status as 200);
      });
    }
  }
}
