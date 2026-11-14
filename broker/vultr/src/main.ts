// Starts the broker. `index.ts` holds the app and refuses to load without its required
// environment, so a misconfigured broker exits here instead of serving.
import { serve } from "@hono/node-server";
import { app } from "./index.ts";

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, () => {
  console.log(`[vultr-broker] listening on ${port} (sha=${process.env.BUILD_SHA ?? "unknown"})`);
});
