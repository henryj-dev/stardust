import { serve } from "@hono/node-server";
import { loadConfig, type StardustConfig } from "@stardust/config";
import { createApp } from "./app.ts";

const configPath = process.env.STARDUST_CONFIG ?? "stardust.yaml";

let config: StardustConfig;
try {
  config = await loadConfig(configPath);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = createApp({ version: process.env.STARDUST_VERSION ?? "dev" });
const server = serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port }, (addr) => {
  console.log(`stardust server listening on ${addr.address}:${addr.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`stardust server stopping (${signal})`);
    server.close();
  });
}
