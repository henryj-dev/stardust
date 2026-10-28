import { serve } from "@hono/node-server";
import { loadConfig, resolveSecretRef, type StardustConfig } from "@stardust/config";
import { createPluginRegistry, type Logger } from "@stardust/core";
import { connect, ensureBootstrapAdmin, migrate } from "@stardust/db";
import { createOidc, plugin as identityOidc, type Oidc } from "@stardust/plugin-identity-oidc";
import { plugin as sourceGithub } from "@stardust/plugin-source-github";
import { createApp, type Services } from "./app.ts";
import { RunEvents } from "./events.ts";
import { compareApi, targetApi } from "./source.ts";

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
  const mine = new Set(["source-github", "identity-oidc"]);
  createPluginRegistry([sourceGithub, identityOidc]).resolve(
    Object.fromEntries(Object.entries(config.plugins).filter(([name]) => mine.has(name))),
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const sql = connect(config.database.url, { max: 8 });
await migrate(sql);

if (config.server.bootstrapAdmin) {
  const { username, password } = config.server.bootstrapAdmin;
  if (await ensureBootstrapAdmin(sql, username, password))
    log.info("created the bootstrap administrator", { username });
}

const source = config.plugins["source-github"] as Record<string, unknown> | undefined;
if (source) {
  if (source.appId !== undefined) {
    console.error("plugins.source-github: GitHub App authentication is not implemented yet; use token");
    process.exit(1);
  }
  const at = "plugins.source-github";
  const events = new RunEvents(sql);
  await events.start();
  const apiBaseUrl = (source.apiBaseUrl as string | undefined) ?? "https://api.github.com";
  // Both are optional: public repositories need no token, and without a webhook secret
  // no webhook is accepted (runs start only when someone asks for one).
  const token = source.token === undefined ? undefined : await resolveSecretRef(source.token, `${at}.token`);
  const webhookSecret =
    source.webhookSecret === undefined
      ? undefined
      : await resolveSecretRef(source.webhookSecret, `${at}.webhookSecret`);
  if (!webhookSecret) log.info("webhooks are off: no plugins.source-github.webhookSecret");
  services = {
    log,
    events,
    sql,
    ...(await oidcServices()),
    ...(webhookSecret ? { webhookSecret } : {}),
    compare: compareApi(apiBaseUrl, token),
    resolveTarget: targetApi(apiBaseUrl, token),
  };
} else {
  console.warn("source-github is not configured: only /healthz is served");
}

/** OpenID sign-in, when configured. Discovery runs at first use and is retried after a failure. */
async function oidcServices(): Promise<Pick<Services, "oidc">> {
  const section = config.plugins["identity-oidc"] as Record<string, unknown> | undefined;
  if (!section) return {};
  const at = "plugins.identity-oidc";
  const redirectUri = `${config.server.publicUrl.replace(/\/+$/, "")}/login/oidc/callback`;
  const options = {
    issuer: section.issuer as string,
    clientId: section.clientId as string,
    clientSecret: await resolveSecretRef(section.clientSecret, `${at}.clientSecret`),
    redirectUri,
    ...(section.scopes ? { scopes: section.scopes as string[] } : {}),
    ...(section.groupsClaim ? { groupsClaim: section.groupsClaim as string } : {}),
  };
  let pending: Promise<Oidc> | null = null;
  const client = () => {
    pending ??= createOidc(options).catch((err: Error) => {
      pending = null;
      log.error("OpenID discovery failed", { issuer: options.issuer, error: err.message });
      throw err;
    });
    return pending;
  };
  log.info("OpenID sign-in enabled", { issuer: options.issuer, redirectUri });
  return {
    oidc: {
      client,
      redirectUri,
      displayName: (section.displayName as string | undefined) ?? "single sign-on",
      autoCreate: section.autoCreate === true,
      rules: {
        ...(section.allowedGroups ? { allowedGroups: section.allowedGroups as string[] } : {}),
        ...(section.adminGroups ? { adminGroups: section.adminGroups as string[] } : {}),
      },
    },
  };
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
