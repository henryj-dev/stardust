/**
 * The job handler for container builds: build the component's image in a
 * Kubernetes Job, then point the deploy repository at the pushed digest.
 * A job succeeds only when both happened — a pushed image that the deploy
 * repository does not reference has not been delivered.
 */
import type { Logger } from "@stardust/core";
import { getProject, type Sql } from "@stardust/db";
import { type BuilderOptions, buildJob, type KubeClient, runBuild } from "@stardust/plugin-builder-buildkit";
import { bumpImage, type RepoIO } from "@stardust/plugin-gitops-git";
import type { HandlerOutcome, JobHandler } from "./loop.ts";

export interface BuildHandlerDeps {
  sql: Sql;
  kube: KubeClient;
  namespace: string;
  /** Registry host and optional path; images are `<registry>/<project>/<component>`. */
  registry: string;
  builder: BuilderOptions;
  deployRepo: RepoIO;
  buildRevAnnotation?: string;
  log: Logger;
  pollMs?: number;
}

const failed = (reason: string, extra: Record<string, unknown> = {}): HandlerOutcome => ({
  result: "failed",
  detail: { reason, ...extra },
});

export function buildHandler(deps: BuildHandlerDeps): JobHandler {
  return async (job, signal) => {
    const project = await getProject(deps.sql, job.projectId);
    if (!project) return failed(`project ${job.projectId} no longer exists`);
    if (!project.githubRepo) return failed("the project has no repository to build from");
    if (job.def.pipeline !== "C" && job.def.pipeline !== "N") {
      return failed(`build kind ${job.def.pipeline} is not supported yet`);
    }

    const name = job.def.component ?? (project.components.length === 1 ? project.components[0]?.name : undefined);
    const component = project.components.find((c) => c.name === name);
    if (!component) return failed(`job "${job.name}" names no known component`);

    const manifest = buildJob(
      {
        projectId: project.id,
        repo: project.githubRepo,
        sha: job.sha,
        component: component.name,
        imageRepository: `${deps.registry}/${project.id}/${component.name}`,
        runId: job.runId,
        jobName: job.name,
        ...(component.context ? { context: component.context } : {}),
        // C builds the repository's Dockerfile; N builds a Node app with the builder's own.
        ...(job.def.pipeline === "N"
          ? {
              kind: "node" as const,
              ...(component.port !== undefined ? { port: component.port } : {}),
              ...(component.buildEnv ? { buildEnv: component.buildEnv } : {}),
            }
          : component.dockerfile
            ? { dockerfile: component.dockerfile }
            : {}),
      },
      deps.builder,
    );
    const outcome = await runBuild(deps.kube, deps.namespace, manifest, {
      signal,
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    });
    const detail: Record<string, unknown> = { buildJob: outcome.jobName };
    if (outcome.result === "cancelled") return { result: "cancelled", detail };
    if (outcome.result === "failed" || !outcome.digest) {
      return failed(outcome.reason ?? "the build failed", { ...detail, logTail: outcome.logTail.slice(-4000) });
    }
    detail.digest = outcome.digest;

    // A pull request is built so its result can be seen, never deployed: its
    // head is unreviewed code, possibly from someone without push access.
    if (job.event === "pull_request") {
      detail.deploy = "skipped: pull requests are built, not deployed";
      deps.log.info("built pull request", { job: job.id, component: component.name, digest: outcome.digest });
      return { result: "success", detail };
    }

    const bump = await bumpImage(deps.deployRepo, {
      dir: component.deployDir,
      project: project.id,
      component: component.name,
      sha: job.sha,
      digest: outcome.digest,
      buildRev: job.id,
      ...(deps.buildRevAnnotation ? { buildRevAnnotation: deps.buildRevAnnotation } : {}),
    });
    if (bump.status === "error") return failed(`deploy repository: ${bump.message}`, detail);
    if (bump.status === "committed") detail.deployCommit = bump.sha;
    deps.log.info("delivered", { job: job.id, component: component.name, digest: outcome.digest, deploy: bump.status });
    return { result: "success", detail };
  };
}
