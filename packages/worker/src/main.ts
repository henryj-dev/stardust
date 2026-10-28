import { hostname } from "node:os";
import { loadConfig, resolveSecretRef, type StardustConfig } from "@stardust/config";
import { createPluginRegistry, type Logger } from "@stardust/core";
import { connect, migrate } from "@stardust/db";
import { plugin as builderPlugin, inClusterClient } from "@stardust/plugin-builder-buildkit";
import { GitCliRepo, plugin as gitopsPlugin, installationTokens, repoFromUrl } from "@stardust/plugin-gitops-git";
import { buildHandler } from "./build-handler.ts";
import { type JobHandler, runWorker } from "./loop.ts";

const configPath = process.env.STARDUST_CONFIG ?? "stardust.yaml";

const log: Logger = {
  debug: (message, fields) => console.debug(JSON.stringify({ level: "debug", message, ...fields })),
  info: (message, fields) => console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};

let config: StardustConfig;
try {
  config = await loadConfig(configPath);
  const mine = ["builder-buildkit", "gitops-git"];
  createPluginRegistry([builderPlugin, gitopsPlugin]).resolve(
    Object.fromEntries(Object.entries(config.plugins).filter(([name]) => mine.includes(name))),
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const sql = connect(config.database.url, { max: 4 });
await migrate(sql);

const builder = config.plugins["builder-buildkit"] as Record<string, unknown> | undefined;
const gitops = config.plugins["gitops-git"] as Record<string, unknown> | undefined;

let handler: JobHandler;
if (builder && gitops) {
  const token = gitops.token ? await resolveSecretRef(gitops.token, "plugins.gitops-git.token") : undefined;
  // A GitHub App instead of a token: installation tokens for the deploy repository, renewed before they expire.
  const app = gitops.githubApp as { appId: number; privateKey: unknown; apiBaseUrl?: string } | undefined;
  const appTokens = app
    ? installationTokens({
        appId: app.appId,
        privateKey: await resolveSecretRef(app.privateKey, "plugins.gitops-git.githubApp.privateKey"),
        repo: repoFromUrl(gitops.url as string) as string,
        ...(app.apiBaseUrl ? { apiBaseUrl: app.apiBaseUrl } : {}),
      })
    : undefined;
  handler = buildHandler({
    sql,
    kube: inClusterClient(),
    namespace: builder.namespace as string,
    registry: builder.registry as string,
    builder: {
      ...(builder.cloneSecret ? { cloneSecret: builder.cloneSecret as string } : {}),
      pushSecret: builder.pushSecret as string,
      ...(builder.gitBaseUrl ? { gitBaseUrl: builder.gitBaseUrl as string } : {}),
      ...(builder.insecureRegistry === true ? { insecureRegistry: true } : {}),
      ...(builder.cloneUsername ? { cloneUsername: builder.cloneUsername as string } : {}),
    },
    deployRepo: new GitCliRepo({
      url: gitops.url as string,
      branch: gitops.branch as string,
      ...(appTokens ? { token: appTokens } : token ? { token } : {}),
      ...(gitops.username ? { username: gitops.username as string } : {}),
    }),
    ...(gitops.buildRevAnnotation ? { buildRevAnnotation: gitops.buildRevAnnotation as string } : {}),
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
await runWorker({ sql, workerId, handler, log, signal: stop.signal });
await sql.end({ timeout: 5 });
