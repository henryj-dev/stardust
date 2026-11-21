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
  projectCatalog,
  type Sql,
  sagaStore,
} from "@stardust/db";
import { inClusterClient } from "@stardust/kube";
import { createApp, type Services } from "./app.ts";
import { type EnvEditor, projectEnvPort } from "./env.ts";
import { RunEvents } from "./events.ts";
import { attachSockets } from "./sockets.ts";

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
  // The global primary when there are several regions; otherwise this same database.
  globalSql = config.database.globalUrl ? connect(config.database.globalUrl, { max: 8 }) : sql;
  const plugins = createPluginRegistry(bundledPlugins).resolve(config.plugins);
  ports = await assemble({
    plugins,
    sections: config.plugins,
    want: ["source", "identity", "builder", "images", "deployRepo", "cipher", "store"],
    platform: {
      database: databasePort(sql),
      globalDatabase: databasePort(globalSql),
      sagas: sagaStore(sql),
      projects: projectCatalog(sql),
      guards: guardStore(sql, globalSql),
      ...kube(),
    },
    resolveSecret: resolveSecretRef,
    log,
    publicUrl: config.server.publicUrl,
    region: config.region,
  });
  const editor = envEditorOf(ports);
  if (editor) ports.projectEnv = projectEnvPort(editor, sql);
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
// The global primary has the whole schema too; each region keeps copies of the global tables (replicated).
if (globalSql !== sql) await migrate(globalSql);
for (const feature of features) {
  await migratePlugin({ regional: sql, global: globalSql }, feature.plugin, await feature.migrations());
}

if (config.server.bootstrapAdmin) {
  const { username, password } = config.server.bootstrapAdmin;
  if (await ensureBootstrapAdmin(sql, username, password))
    log.info("created the bootstrap administrator", { username });
}

if (config.auth.local.totp !== "off" && !config.auth.local.totpKey) {
  log.warn("TOTP secrets are stored unsealed: set auth.local.totpKey to encrypt them in the database");
}
const auth = {
  localEnabled: config.auth.local.enabled,
  totp: config.auth.local.totp,
  ...(config.auth.local.totpKey ? { totpKey: config.auth.local.totpKey } : {}),
  reauthMinutes: config.auth.reauthMinutes,
  issuer: `stardust (${new URL(config.server.publicUrl).host})`,
};

let services: Services | undefined;
if (ports.source) {
  const events = new RunEvents(sql);
  await events.start();
  services = {
    log,
    events,
    sql,
    globalSql,
    auth,
    resolveTarget: (repo, target) => (ports.source as NonNullable<Ports["source"]>).resolveTarget(repo, target),
    ...(ports.source.access ? { repoAccess: ports.source.access.bind(ports.source) } : {}),
    ...(ports.identity ? { oidc: ports.identity } : {}),
    ...(ports.deployRepo ? { deployRepo: ports.deployRepo } : {}),
    ...(ports.store ? { store: ports.store } : {}),
    ...(ports.images ? { images: ports.images } : {}),
    features,
    region: config.region,
    upstreamBuilds: config.jobs.upstreamBuilds,
    ...buildLogServices(),
    ...envServices(),
    ...runtimeGrantServices(),
    ...(typeof config.plugins.runtime === "object" &&
    config.plugins.runtime !== null &&
    "external" in config.plugins.runtime
      ? { componentAddresses: true }
      : {}),
  };
} else {
  console.warn("source-github is not configured: only /healthz is served");
}

/**
 * Who the server reads the cluster as, from the chart: its read-only runtime
 * ClusterRole, and its own service account (from the downward API). Then the
 * dashboard can bind that role in a component's namespace.
 */
function runtimeGrantServices(): Pick<Services, "runtimeGrant"> {
  const clusterRole = process.env.STARDUST_RUNTIME_CLUSTERROLE;
  const serviceAccount = process.env.STARDUST_SERVICE_ACCOUNT;
  const serviceAccountNamespace = process.env.STARDUST_NAMESPACE;
  if (!clusterRole || !serviceAccount || !serviceAccountNamespace) return {};
  log.info("pod view bindings enabled", { clusterRole });
  return { runtimeGrant: { clusterRole, serviceAccount, serviceAccountNamespace } };
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
  const editor = envEditorOf(ports);
  if (!editor) {
    log.info("editing env is off: a deploy repository and a cipher are not both available");
    return {};
  }
  log.info("editing env enabled", { envRoot: editor.root ?? "deploy/env" });
  return { env: editor };
}

function envEditorOf(p: Partial<Ports>): EnvEditor | undefined {
  const { deployRepo, cipher } = p;
  if (!deployRepo || !cipher) return undefined;
  return {
    repo: deployRepo.repo,
    codec: cipher,
    ...(deployRepo.envRoot ? { root: deployRepo.envRoot } : {}),
    revisionKey: cipher.revisionKey,
  };
}

const app = createApp({ version: process.env.STARDUST_VERSION ?? "dev" }, services);
const server = serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port }, (addr) => {
  console.log(`stardust server listening on ${addr.address}:${addr.port}`);
});
const closeSockets = attachSockets(server as unknown as import("node:http").Server, features, log);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`stardust server stopping (${signal})`);
    closeSockets();
    server.close();
    void sql.end({ timeout: 5 });
  });
}
