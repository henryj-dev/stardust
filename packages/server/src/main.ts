import { serve } from "@hono/node-server";
import { loadConfig, resolveSecretRef, type StardustConfig } from "@stardust/config";
import { createPluginRegistry, type Logger } from "@stardust/core";
import { connect, migrate } from "@stardust/db";
import { plugin as sourceGithub } from "@stardust/plugin-source-github";
import { createApp, type Services } from "./app.ts";
import { RunEvents } from "./events.ts";
import { compareApi } from "./source.ts";

const configPath = process.env.STARDUST_CONFIG ?? "stardust.yaml";

const log: Logger = {
  debug: (message, fields) => console.debug(JSON.stringify({ level: "debug", message, ...fields })),
  info: (message, fields) => console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};

let config: StardustConfig;
let services: Services | undefined;
try {
  config = await loadConfig(configPath);
  // The server reads only the source plugin's section; the registry still
  // validates every enabled section so a typo stops start-up here too.
  createPluginRegistry([sourceGithub]).resolve(
    Object.fromEntries(Object.entries(config.plugins).filter(([name]) => name === "source-github")),
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const sql = connect(config.database.url, { max: 8 });
await migrate(sql);

const source = config.plugins["source-github"] as Record<string, unknown> | undefined;
if (source && config.server.adminToken) {
  if (source.appId !== undefined) {
    console.error("plugins.source-github: GitHub App authentication is not implemented yet; use token");
    process.exit(1);
  }
  const at = "plugins.source-github";
  const events = new RunEvents(sql);
  await events.start();
  services = {
    log,
    events,
    sql,
    adminToken: config.server.adminToken,
    webhookSecret: await resolveSecretRef(source.webhookSecret, `${at}.webhookSecret`),
    compare: compareApi(
      (source.apiBaseUrl as string | undefined) ?? "https://api.github.com",
      await resolveSecretRef(source.token, `${at}.token`),
    ),
  };
} else {
  console.warn("source-github or server.adminToken is not configured: only /healthz is served");
}

const app = createApp({ version: process.env.STARDUST_VERSION ?? "dev" }, services);
const server = serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port }, (addr) => {
  console.log(`stardust server listening on ${addr.address}:${addr.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`stardust server stopping (${signal})`);
    server.close();
    void sql.end({ timeout: 5 });
  });
}
