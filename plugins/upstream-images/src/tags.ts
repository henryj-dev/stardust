/**
 * Which published tag is the newest. Semantic versions win (a leading `v`
 * allowed); a stable release beats a pre-release; tags that are not versions
 * come last, ordered naturally. Pure, so the choice is tested apart from the
 * registry.
 */

export interface Candidate {
  tag: string;
  digest: string;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function versionOf(tag: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(tag.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[4] ?? null };
}

function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true });
}

/** Candidates with a valid digest, newest first. */
export function rank(tags: ReadonlyArray<{ name?: unknown; digest?: unknown }>): Candidate[] {
  return tags
    .filter(
      (t): t is { name: string; digest: string } =>
        typeof t.name === "string" && typeof t.digest === "string" && /^sha256:[0-9a-f]{64}$/i.test(t.digest),
    )
    .map((t) => ({ tag: t.name, digest: t.digest.toLowerCase() }))
    .sort((a, b) => {
      const va = versionOf(a.tag);
      const vb = versionOf(b.tag);
      if (va && vb) return compare(vb, va);
      if (va) return -1;
      if (vb) return 1;
      return b.tag.localeCompare(a.tag, undefined, { numeric: true, sensitivity: "base" });
    });
}

/** The newest stable release, else the newest version, else the first tag. */
export function latest(ranked: readonly Candidate[]): Candidate | undefined {
  return ranked.find((c) => versionOf(c.tag)?.pre === null) ?? ranked.find((c) => versionOf(c.tag)) ?? ranked[0];
}

/** `docker.io/org/app:1.2@sha256:…` → its parts; null when it is not a Docker Hub image. */
export function dockerHubRef(pinned: string): { repo: string; tag: string | null; digest: string } | null {
  const m =
    /^(?:docker\.io\/)?([a-z0-9][a-z0-9_.-]{0,127}\/[a-z0-9][a-z0-9_.-]{0,127})(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?@(sha256:[0-9a-f]{64})$/.exec(
      pinned,
    );
  if (!m) return null;
  return { repo: m[1] ?? "", tag: m[2] ?? null, digest: m[3] ?? "" };
}
