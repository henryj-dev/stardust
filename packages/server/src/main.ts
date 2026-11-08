import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { loadConfig, resolveSecretRef, type StardustConfig } from "@stardust/config";
import { createPluginRegistry, type Logger } from "@stardust/core";
import { connect, ensureBootstrapAdmin, migrate } from "@stardust/db";
import { plugin as builderBuildkit, buildLogReader, inClusterClient } from "@stardust/plugin-builder-buildkit";
import { GitCliRepo, plugin as gitopsGit, installationTokens, repoFromUrl } from "@stardust/plugin-gitops-git";
import { createOidc, plugin as identityOidc, type Oidc } from "@stardust/plugin-identity-oidc";
import { decrypt, encryptIfChanged, plugin as secretsSopsAge } from "@stardust/plugin-secrets-sops-age";
import { RETIRED_KEYS, plugin as sourceGithub } from "@stardust/plugin-source-github";
import { createApp, type Services } from "./app.ts";
import { RunEvents } from "./events.ts";
import { targetApi } from "./source.ts";

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
  // The server reads only these sections (the builder's for its namespace, to
  // show build logs); the registry validates them so a typo stops start-up here too.
  // (and, to edit env, the deploy repository's and SOPS's).
  const mine = new Set(["source-github", "identity-oidc", "builder-buildkit", "gitops-git", "secrets-sops-age"]);
  createPluginRegistry([sourceGithub, identityOidc, builderBuildkit, gitopsGit, secretsSopsAge]).resolve(
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
  // Optional: public repositories need no token.
  const token = source.token === undefined ? undefined : await resolveSecretRef(source.token, `${at}.token`);
  for (const [key, why] of Object.entries(RETIRED_KEYS)) {
    if (source[key] !== undefined) log.warn(`${at}.${key} is ignored: ${why}`);
  }
  services = {
    log,
    events,
    sql,
    ...(await oidcServices()),
    ...buildLogServices(),
    ...(await envServices()),
    resolveTarget: targetApi(apiBaseUrl, token),
  };
} else {
  console.warn("source-github is not configured: only /healthz is served");
}

/**
 * Build logs, read from the build pods: only with builds configured and a
 * service account token mounted (the chart gives the server a read-only one).
 */
function buildLogServices(): Pick<Services, "buildLogs"> {
  const section = config.plugins["builder-buildkit"] as { namespace?: string } | undefined;
  if (!section?.namespace) return {};
  if (!process.env.KUBERNETES_SERVICE_HOST || !existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) {
    log.info("build logs are off: no Kubernetes service account is mounted");
    return {};
  }
  log.info("build logs enabled", { namespace: section.namespace });
  return { buildLogs: buildLogReader(inClusterClient(), section.namespace) };
}

/**
 * Editing env and secrets: with a deploy repository (gitops-git) and SOPS
 * (secrets-sops-age) configured, and the age identity mounted. The server
 * then writes to the deploy repository and decrypts the env layers it edits.
 */
async function envServices(): Promise<Pick<Services, "env">> {
  const gitops = config.plugins["gitops-git"] as Record<string, unknown> | undefined;
  const sops = config.plugins["secrets-sops-age"] as
    | { ageKeyFile: string; recipients: string[]; sopsBinary?: string }
    | undefined;
  if (!gitops || !sops) {
    log.info("editing env is off: gitops-git and secrets-sops-age are not both configured");
    return {};
  }
  let identity: Buffer;
  try {
    identity = readFileSync(sops.ageKeyFile);
  } catch {
    log.warn("editing env is off: the age identity is not mounted", { ageKeyFile: sops.ageKeyFile });
    return {};
  }
  const token = gitops.token ? await resolveSecretRef(gitops.token, "plugins.gitops-git.token") : undefined;
  const app = gitops.githubApp as { appId: number; privateKey: unknown; apiBaseUrl?: string } | undefined;
  const appTokens = app
    ? installationTokens({
        appId: app.appId,
        privateKey: await resolveSecretRef(app.privateKey, "plugins.gitops-git.githubApp.privateKey"),
        repo: repoFromUrl(gitops.url as string) as string,
        ...(app.apiBaseUrl ? { apiBaseUrl: app.apiBaseUrl } : {}),
      })
    : undefined;
  const options = {
    ageKeyFile: sops.ageKeyFile,
    recipients: sops.recipients,
    ...(sops.sopsBinary ? { bin: sops.sopsBinary } : {}),
  };
  log.info("editing env enabled", { repo: repoFromUrl(gitops.url as string) ?? "(not GitHub)" });
  return {
    env: {
      repo: new GitCliRepo({
        url: gitops.url as string,
        branch: gitops.branch as string,
        ...(appTokens ? { token: appTokens } : token ? { token } : {}),
        ...(gitops.username ? { username: gitops.username as string } : {}),
      }),
      codec: {
        decrypt: (document) => decrypt(document, options),
        encryptIfChanged: (current, plain) => encryptIfChanged(current, plain, options),
      },
      // Derived from the age identity: secret, stable, and nothing more to configure.
      revisionKey: createHash("sha256").update("stardust env revision\0").update(identity).digest("hex"),
    },
  };
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
