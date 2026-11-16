import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { bundledPlugins } from "@stardust/bundle";
import { loadConfig, resolveSecretRef, type StardustConfig } from "@stardust/config";
import { assemble, buildFeatures, createPluginRegistry, type Feature, type Logger, type Ports } from "@stardust/core";
import {
  connect,
  databasePort,
  ensureBootstrapAdmin,
  guardStore,
  migrate,
  migratePlugin,
  type Sql,
  sagaStore,
} from "@stardust/db";
import { inClusterClient } from "@stardust/kube";
import { createApp, type Services } from "./app.ts";
import { RunEvents } from "./events.ts";

const configPath = process.env.STARDUST_CONFIG ?? "stardust.yaml";

const log: Logger = {
  debug: (message, fields) => console.debug(JSON.stringify({ level: "debug", message, ...fields })),
  info: (message, fields) => console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};

let config: StardustConfig;
let ports: Partial<Ports>;
let features: Feature[];
let sql: Sql;
let globalSql: Sql;
try {
  config = await loadConfig(configPath);
  sql = connect(config.database.url, { max: 8 });
  // One database until there are several regions: then the global one is its own (see the plan's P8).
  globalSql = sql;
  const plugins = createPluginRegistry(bundledPlugins).resolve(config.plugins);
  ports = await assemble({
    plugins,
    sections: config.plugins,
    want: ["source", "identity", "builder", "deployRepo", "cipher"],
    platform: {
      database: databasePort(sql),
      globalDatabase: databasePort(globalSql),
      sagas: sagaStore(sql),
      guards: guardStore(sql, globalSql),
      ...kube(),
    },
    resolveSecret: resolveSecretRef,
    log,
    publicUrl: config.server.publicUrl,
    region: config.region,
  });
  features = buildFeatures(plugins, config.plugins, ports, log, config.region);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

/**
 * The Kubernetes API, for build logs: only with a service account token
 * mounted (the chart gives the server a read-only one).
 */
function kube(): Partial<Ports> {
  if (process.env.KUBERNETES_SERVICE_HOST && existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) {
    return { kube: inClusterClient() };
  }
  return {};
}

await migrate(sql);
for (const feature of features) {
  await migratePlugin({ regional: sql, global: globalSql }, feature.plugin, await feature.migrations());
}

if (config.server.bootstrapAdmin) {
  const { username, password } = config.server.bootstrapAdmin;
  if (await ensureBootstrapAdmin(sql, username, password))
    log.info("created the bootstrap administrator", { username });
}

let services: Services | undefined;
if (ports.source) {
  const events = new RunEvents(sql);
  await events.start();
  services = {
    log,
    events,
    sql,
    globalSql,
    resolveTarget: (repo, target) => (ports.source as NonNullable<Ports["source"]>).resolveTarget(repo, target),
    ...(ports.identity ? { oidc: ports.identity } : {}),
    ...(ports.deployRepo ? { deployRepo: ports.deployRepo } : {}),
    features,
    ...buildLogServices(),
    ...envServices(),
  };
} else {
  console.warn("source-github is not configured: only /healthz is served");
}

/** Build logs, read from the build pods. */
function buildLogServices(): Pick<Services, "buildLogs"> {
  const logs = ports.builder?.logs;
  if (!logs) {
    if (config.plugins["builder-buildkit"]) log.info("build logs are off: no Kubernetes service account is mounted");
    return {};
  }
  log.info("build logs enabled");
  return { buildLogs: logs };
}

/**
 * Editing env and secrets: with a deploy repository and a cipher (gitops-git
 * and secrets-sops-age with its age identity mounted). The server then
 * writes to the deploy repository and decrypts the env layers it edits.
 */
function envServices(): Pick<Services, "env"> {
  const { deployRepo, cipher } = ports;
  if (!deployRepo || !cipher) {
    log.info("editing env is off: a deploy repository and a cipher are not both available");
    return {};
  }
  log.info("editing env enabled", { envRoot: deployRepo.envRoot ?? "deploy/env" });
  return {
    env: {
      repo: deployRepo.repo,
      codec: cipher,
      ...(deployRepo.envRoot ? { root: deployRepo.envRoot } : {}),
      revisionKey: cipher.revisionKey,
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
