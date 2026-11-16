/**
 * The plugins compiled into stardust. This list is the only place outside
 * the plugins that knows them: the server and the worker get ports from
 * `assemble`, never a plugin's functions. A new plugin is one line here.
 */
import type { Plugin } from "@stardust/core";
import { plugin as builderBuildkit } from "@stardust/plugin-builder-buildkit";
import { plugin as cloudVultr } from "@stardust/plugin-cloud-vultr";
import { plugin as databases } from "@stardust/plugin-databases";
import { plugin as dbStatefulset } from "@stardust/plugin-db-statefulset";
import { plugin as dnsCloudflare } from "@stardust/plugin-dns-cloudflare";
import { plugin as dnsParallax } from "@stardust/plugin-dns-parallax";
import { plugin as domains } from "@stardust/plugin-domains";
import { plugin as gitopsGit } from "@stardust/plugin-gitops-git";
import { plugin as identityOidc } from "@stardust/plugin-identity-oidc";
import { plugin as logsKube } from "@stardust/plugin-logs-kube";
import { plugin as logsLoki } from "@stardust/plugin-logs-loki";
import { plugin as nodes } from "@stardust/plugin-nodes";
import { plugin as runtime } from "@stardust/plugin-runtime";
import { plugin as secretsSopsAge } from "@stardust/plugin-secrets-sops-age";
import { plugin as sourceGithub } from "@stardust/plugin-source-github";
import { plugin as storeS3 } from "@stardust/plugin-store-s3";
import { plugin as targetCfWorkers } from "@stardust/plugin-target-cf-workers";

export const bundledPlugins: readonly Plugin[] = [
  builderBuildkit,
  cloudVultr,
  databases,
  dbStatefulset,
  dnsCloudflare,
  dnsParallax,
  domains,
  gitopsGit,
  identityOidc,
  logsKube,
  logsLoki,
  nodes,
  runtime,
  secretsSopsAge,
  sourceGithub,
  storeS3,
  targetCfWorkers,
];
