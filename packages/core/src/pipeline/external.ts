/**
 * Projects whose code is someone else's: an open-source project deployed as
 * it is, without a fork. Every decision that differs for them is made here,
 * in one place: scattered `if (external)` checks are how one gets missed,
 * and a missed one quietly behaves as if the code were trusted.
 *
 * - Its builds get no clone token and no project secret: an upstream build
 *   script or Dockerfile `RUN` is code nobody here reviewed.
 * - By default it is not built at all, only mirrored (pipeline M): its
 *   published image, pinned by digest, is copied into our registry by a Job
 *   that runs none of its code. Building its code takes the operator listing
 *   the project in `jobs.upstreamBuilds`: a build still pushes, so dropping
 *   the tokens alone is not a boundary.
 * - With a pin, only the pinned commit is run.
 */
import type { JobPipeline } from "./definition.ts";

export interface Trust {
  external: boolean;
  /** The commit an external project is pinned to, if any. */
  pin: string | null;
}

export function trustOf(metadata: Readonly<Record<string, unknown>> | null | undefined): Trust {
  const external = metadata?.trust === "external";
  const pin = typeof metadata?.pin === "string" && /^[0-9a-f]{40}$/.test(metadata.pin) ? metadata.pin : null;
  return { external, pin };
}

export type BuildDecision = { ok: true; trusted: boolean } | { ok: false; reason: string };

export function buildDecision(
  trust: Trust,
  input: { projectId: string; pipeline: JobPipeline; sha: string },
  upstreamBuilds: readonly string[],
): BuildDecision {
  if (!trust.external) return { ok: true, trusted: true };
  if (trust.pin && input.sha !== trust.pin) {
    return {
      ok: false,
      reason: `the project is pinned to ${trust.pin.slice(0, 12)}: move the pin to run another commit`,
    };
  }
  if (input.pipeline === "M") return { ok: true, trusted: false };
  if (!upstreamBuilds.includes(input.projectId)) {
    return {
      ok: false,
      reason:
        "an external project's code is not built: mirror its published image (pipeline M), or list it in jobs.upstreamBuilds",
    };
  }
  return { ok: true, trusted: false };
}

/** An image reference pinned by digest, e.g. `docker.io/org/app:1.2@sha256:…`. */
export const PINNED_IMAGE =
  /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[0-9a-f]{64}$/;

export function digestOf(pinned: string): string | null {
  return /@(sha256:[0-9a-f]{64})$/.exec(pinned)?.[1] ?? null;
}
