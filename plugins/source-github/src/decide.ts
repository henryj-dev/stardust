/**
 * Turns a verified GitHub webhook into a decision: ignore it (with a reason)
 * or start a run (with the event context the pipeline needs). Pure, so every
 * guard — including that the fork check happens before a run is started — is
 * tested by calling it rather than by reading the HTTP handler's source.
 */
import { judgeForkPullRequest } from "./fork.ts";
import { isProjectDisabled, judgePush, type WebhookPolicy } from "./policy.ts";

export interface ProjectView {
  metadata?: unknown;
}

export type Decision =
  | { action: "ignore"; reason: string }
  | {
      action: "run";
      event: "push" | "pull_request";
      trigger: "push" | "tag" | "pull_request";
      ref: string;
      sha: string;
      branch?: string;
      tag?: string;
      baseBranch?: string;
    };

export function refToBranchTag(ref: string): { branch?: string; tag?: string } {
  if (ref.startsWith("refs/heads/")) return { branch: ref.slice("refs/heads/".length) };
  if (ref.startsWith("refs/tags/")) return { tag: ref.slice("refs/tags/".length) };
  return {};
}

const BUILD_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export function decideWebhook(
  eventName: string | undefined,
  payload: unknown,
  policy: WebhookPolicy,
  project: ProjectView,
): Decision {
  if (policy.skipDisabled && isProjectDisabled(project.metadata)) {
    return { action: "ignore", reason: "project is disabled" };
  }
  const p = (payload ?? {}) as Record<string, unknown>;

  if (eventName === "push") {
    // Deliberate difference from the predecessor, which started a run for the
    // all-zero `after` of a deleted ref and failed it in the build.
    if (p.deleted === true) return { action: "ignore", reason: "ref deleted" };
    const ref = typeof p.ref === "string" ? p.ref : "";
    const sha = typeof p.after === "string" ? p.after : "";
    if (!ref || !sha) return { action: "ignore", reason: "push without ref or after" };
    const message = (p.head_commit as { message?: unknown } | null)?.message;
    const skip = judgePush(typeof message === "string" ? message : "", policy);
    if (skip) return { action: "ignore", reason: skip.reason };
    const trigger = ref.startsWith("refs/tags/") ? "tag" : "push";
    return { action: "run", event: "push", trigger, ref, sha, ...refToBranchTag(ref) };
  }

  if (eventName === "pull_request") {
    const action = typeof p.action === "string" ? p.action : "";
    if (!BUILD_ACTIONS.has(action)) return { action: "ignore", reason: `pull_request action "${action}"` };
    const pr = p.pull_request as { number?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown } } | undefined;
    const sha = typeof pr?.head?.sha === "string" ? pr.head.sha : "";
    if (!sha) return { action: "ignore", reason: "pull_request without head.sha" };
    // Before anything is started: a fork's code must never run with our credentials.
    if (policy.judgeForkPr) {
      const verdict = judgeForkPullRequest(payload);
      if (verdict.fork) return { action: "ignore", reason: `fork pull request: ${verdict.reason}` };
    }
    const baseBranch = typeof pr?.base?.ref === "string" ? pr.base.ref : undefined;
    return {
      action: "run",
      event: "pull_request",
      trigger: "pull_request",
      ref: `refs/pull/${String(pr?.number ?? "")}/head`,
      sha,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
    };
  }

  return { action: "ignore", reason: `event "${eventName ?? "none"}" is not handled` };
}
