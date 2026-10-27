/**
 * The decision a delivery leads to, up to (not including) starting a run:
 * policy, triggers, then changed paths. The webhook acts on it; the plan
 * endpoint only reports it. One function, so a plan is what a delivery does.
 */
import { evaluateOn, pipelineDefFromComponents } from "@stardust/core";
import type { Project } from "@stardust/db";
import { type CompareResult, decideWebhook, POLICY, resolveChangedPaths } from "@stardust/plugin-source-github";

export type DeliveryPlan =
  | { action: "ignore"; reason: string }
  | {
      action: "run";
      event: "push" | "pull_request";
      trigger: "push" | "tag" | "pull_request";
      ref: string;
      sha: string;
      def: unknown;
      changedPaths: string[] | null;
      /** Where the changed paths came from; "commits" when the compare API could not be used. */
      pathsFrom: "given" | "compare" | "commits" | "none";
      fallback?: string;
    };

export async function planDelivery(input: {
  project: Project;
  event: string | undefined;
  payload: Record<string, unknown>;
  compare: (repo: string, base: string, head: string) => Promise<CompareResult>;
  /** Use these changed paths instead of asking the source host (replaying a recorded decision). */
  changedPaths?: string[] | null;
}): Promise<DeliveryPlan> {
  const { project, payload } = input;
  const decision = decideWebhook(input.event, payload, POLICY[project.webhookKind], project);
  if (decision.action === "ignore") return decision;

  const def = project.pipelineDef ?? pipelineDefFromComponents(project.components);
  const ctx = {
    ...(decision.branch !== undefined ? { branch: decision.branch } : {}),
    ...(decision.tag !== undefined ? { tag: decision.tag } : {}),
    ...(decision.baseBranch !== undefined ? { baseBranch: decision.baseBranch } : {}),
    ...(decision.defaultBranch !== undefined ? { defaultBranch: decision.defaultBranch } : {}),
  };
  if (!evaluateOn(def, decision.event, ctx)) {
    return { action: "ignore", reason: `no trigger matches ${decision.event} ${decision.ref}` };
  }

  const base = {
    action: "run" as const,
    event: decision.event,
    trigger: decision.trigger,
    ref: decision.ref,
    sha: decision.sha,
    def,
  };
  if (decision.event !== "push") return { ...base, changedPaths: null, pathsFrom: "none" };
  if (input.changedPaths !== undefined) return { ...base, changedPaths: input.changedPaths, pathsFrom: "given" };
  const repo = project.githubRepo;
  const resolved = await resolveChangedPaths({
    payload,
    compare: (b, h) => (repo ? input.compare(repo, b, h) : Promise.reject(new Error("project has no repository"))),
  });
  return resolved.fallback
    ? { ...base, changedPaths: resolved.paths, pathsFrom: "commits", fallback: resolved.fallback }
    : { ...base, changedPaths: resolved.paths, pathsFrom: "compare" };
}
