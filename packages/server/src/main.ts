import { serve } from "@hono/node-server";
import { loadConfig } from "@stardust/config";
import { createApp } from "./app.ts";

const configPath = process.env.STARDUST_CONFIG ?? "stardust.yaml";

try {
  const config = await loadConfig(configPath);
  const app = createApp({ version: process.env.STARDUST_VERSION ?? "dev" });
  serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port }, (addr) => {
    console.log(`stardust server listening on ${addr.address}:${addr.port}`);
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
