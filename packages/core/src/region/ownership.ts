/**
 * Which region owns a project. With several regions, each runs its own
 * stardust; a project's runs, env and manifests belong to one of them, and
 * only that one changes them. Another region refuses and names the owner,
 * so the unified dashboard can send the change there (it never routes
 * around a region it cannot reach).
 *
 * A project with no owner (from before regions) is changed by any region,
 * which is how one region behaves.
 */

const REGION = /^[a-z][a-z0-9-]{0,62}$/;

export function ownerRegion(metadata: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const r = metadata?.region;
  return typeof r === "string" && REGION.test(r) ? r : null;
}

/** The owning region when it is not this one; null when this region may change the project. */
export function ownedElsewhere(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  here: string | undefined,
): string | null {
  const owner = ownerRegion(metadata);
  return owner && here && owner !== here ? owner : null;
}
