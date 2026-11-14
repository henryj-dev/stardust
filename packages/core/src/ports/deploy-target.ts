/**
 * Deploying outside Kubernetes: a pipeline whose result is not an image in
 * the deploy repository but a release somewhere else (a Cloudflare Worker).
 * The worker hands a job of that pipeline to the target named after it,
 * instead of the builder; the target builds and releases in one go, and a
 * job succeeds only when the release happened.
 */
import type { BuildLogReader, BuildOptions } from "./builder.ts";

export interface DeployRequest {
  projectId: string;
  /** `owner/name` on the source host. */
  repo: string;
  /** Full commit SHA to release. */
  sha: string;
  component: string;
  /** Directory of the app inside the repository. Defaults to the root. */
  context?: string;
  /** Environment during the build. Not secret. */
  buildEnv?: Record<string, string>;
  /** False for code nobody here reviewed: no clone token. */
  trusted?: boolean;
  runId: string;
  jobName: string;
}

export interface DeployOutcome {
  result: "success" | "failed" | "cancelled";
  jobName: string;
  /** What the target calls the release, e.g. a Worker version id. */
  version?: string;
  reason?: string;
  /** The last lines of the log. */
  logTail: string;
}

export interface DeployTarget {
  deploy(request: DeployRequest, options: BuildOptions): Promise<DeployOutcome>;
  logs?: BuildLogReader;
}
