import { hostname } from "node:os";
import { bundledPlugins } from "@stardust/bundle";
import { loadConfig, resolveSecretRef, type StardustConfig } from "@stardust/config";
import { assemble, buildFeatures, createPluginRegistry, type Feature, type Logger, type Ports } from "@stardust/core";
import {
  connect,
  databasePort,
  guardStore,
  migrate,
  migratePlugin,
  projectCatalog,
  type Sql,
  sagaStore,
} from "@stardust/db";
import { inClusterClient } from "@stardust/kube";
import { buildHandler } from "./build-handler.ts";
import { startHousekeeping } from "./housekeeping.ts";
import { type JobHandler, runWorker } from "./loop.ts";
import { startSchedules } from "./schedules.ts";

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
  sql = connect(config.database.url, { max: 4 });
  // One database until there are several regions: then the global one is its own (see the plan's P8).
  globalSql = sql;
  const plugins = createPluginRegistry(bundledPlugins).resolve(config.plugins);
  ports = await assemble({
    plugins,
    sections: config.plugins,
    want: ["builder", "deployRepo", "store", "deployTargets", "source"],
    // Builds run as Kubernetes Jobs: a worker that builds runs in the cluster.
    platform: {
      database: databasePort(sql),
      globalDatabase: databasePort(globalSql),
      sagas: sagaStore(sql),
      projects: projectCatalog(sql),
      guards: guardStore(sql, globalSql),
      ...(config.plugins["builder-buildkit"] && config.plugins["gitops-git"] ? { kube: inClusterClient() } : {}),
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

await migrate(sql);
for (const feature of features) {
  await migratePlugin({ regional: sql, global: globalSql }, feature.plugin, await feature.migrations());
}

let handler: JobHandler;
if (ports.builder && ports.deployRepo) {
  handler = buildHandler({
    sql,
    builder: ports.builder,
    deployRepo: ports.deployRepo.repo,
    ...(ports.store ? { store: ports.store } : {}),
    ...(ports.deployTargets ? { targets: ports.deployTargets } : {}),
    ...(ports.source ? { source: ports.source } : {}),
    upstreamBuilds: config.jobs.upstreamBuilds,
    ...(ports.deployRepo.buildRevAnnotation ? { buildRevAnnotation: ports.deployRepo.buildRevAnnotation } : {}),
    log,
  });
} else {
  // Without a builder and a deploy repository there is nothing to run jobs
  // with. Fail them loudly rather than leaving runs waiting forever.
  log.warn("builder-buildkit or gitops-git is not configured: jobs will fail");
  handler = async () => ({
    result: "failed",
    detail: { reason: "no builder or deploy repository is configured" },
  });
}

const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`stardust worker stopping (${signal})`);
    stop.abort();
  });
}

const workerId = `${hostname()}:${process.pid}`;
console.log(`stardust worker started (${workerId})`);
startHousekeeping({ sql, globalSql, log, auditRetentionDays: config.audit.retentionDays, signal: stop.signal });
startSchedules({ sql, features, holder: workerId, log, signal: stop.signal });
await runWorker({ sql, workerId, handler, log, signal: stop.signal, maxRunning: config.jobs.maxRunning });
await sql.end({ timeout: 5 });
