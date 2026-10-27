import { Hono } from "hono";

export interface AppInfo {
  readonly version: string;
}

/** Builds the HTTP application. Kept free of I/O so tests can call `app.request()`. */
export function createApp(info: AppInfo): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok", version: info.version }));
  return app;
}
