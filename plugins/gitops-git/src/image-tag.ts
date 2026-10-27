/**
 * Bumping a component's image in its deploy directory.
 *
 * Every manifest in the component's directory that references the image is
 * updated — not only deployment.yaml. Naming one file breaks silently the day a
 * second manifest uses the same image: the build succeeds, the bump commit
 * lands, and the second workload stays on the old image forever.
 *
 * Only that directory is covered: the same image used from another directory
 * is still not seen.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `<anything>/<project>/<component>:<tag>[@sha256:<digest>]`. The registry host
 * does not matter (it can move); the path and the tag do. The digest is part
 * of the match so a pinned reference is replaced whole.
 */
export function imageTagPattern(project: string, component: string): RegExp {
  return new RegExp(`([\\w.-]+/${esc(project)}/${esc(component)}:)([\\w.-]+(?:@sha256:[0-9a-f]{64})?)`, "g");
}

/**
 * The reference to deploy: `<short sha>@sha256:<digest>` when the digest is
 * known, so rebuilding the same commit with different content changes the
 * manifest and rolls the workload out; just the short SHA otherwise.
 */
export function imageRefTag(shortSha: string, digest?: string | null): string {
  const hex = digest?.replace(/^sha256:/, "");
  return hex && /^[0-9a-f]{64}$/i.test(hex) ? `${shortSha}@sha256:${hex.toLowerCase()}` : shortSha;
}

export interface RewriteResult {
  text: string;
  /** References found, including ones already up to date: "this file uses this image". */
  matched: number;
  /** References whose value changed. 0 means already up to date. */
  changed: number;
  oldTags: string[];
}

export function rewriteImageTag(
  text: string,
  project: string,
  component: string,
  shortSha: string,
  digest?: string | null,
): RewriteResult {
  const next = imageRefTag(shortSha, digest);
  let matched = 0;
  let changed = 0;
  const oldTags: string[] = [];
  const out = text.replace(imageTagPattern(project, component), (_m, prefix: string, tag: string) => {
    matched += 1;
    if (!oldTags.includes(tag)) oldTags.push(tag);
    if (tag !== next) changed += 1;
    return `${prefix}${next}`;
  });
  return { text: out, matched, changed, oldTags };
}

/**
 * Sets the value of a build-revision annotation — only where the annotation
 * already exists. Changing it changes the pod template, so a rebuild whose
 * image reference did not change still rolls out. Manifests without it are
 * left alone. The annotation key is configuration (`buildRevAnnotation`).
 */
export function rewriteBuildRev(text: string, annotation: string, rev: string): { text: string; changed: number } {
  let changed = 0;
  const re = new RegExp(`(${esc(annotation)}:\\s*")([^"]*)(")`, "g");
  const out = text.replace(re, (_m, pre: string, old: string, post: string) => {
    if (old !== rev) changed += 1;
    return `${pre}${rev}${post}`;
  });
  return { text: out, changed };
}

/**
 * Whether a file may be rewritten. SOPS files are excluded even though they
 * can match: fields outside `data`/`stringData` stay plain text, and editing
 * them breaks the document's MAC, so the GitOps controller fails to decrypt it
 * and the whole Kustomization stops. Every other YAML file is a candidate; a
 * file that does not reference the image is simply not changed.
 */
export function isBumpCandidate(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".yaml") && !lower.endsWith(".yml")) return false;
  return !(lower.endsWith(".enc.yaml") || lower.endsWith(".enc.yml"));
}

/** deployment.yaml first, then by name, so the same input gives the same output. */
export function orderBumpCandidates(names: string[]): string[] {
  const rest = names.filter((n) => n !== "deployment.yaml").sort();
  return names.includes("deployment.yaml") ? ["deployment.yaml", ...rest] : rest;
}

export interface FileRewrite extends RewriteResult {
  name: string;
}

export interface DirectoryPlan {
  /** Files to commit (`changed > 0`). */
  toCommit: FileRewrite[];
  /**
   * Every file that references the image, up to date or not. "Nothing to
   * commit" with references is normal; with no references the coordinates are
   * wrong — both look like zero commits, so they are kept apart.
   */
  referencing: FileRewrite[];
}

export interface DirectoryRewrite {
  project: string;
  component: string;
  shortSha: string;
  digest?: string | null;
  /** A value unique per build (the job id). With `buildRevAnnotation`, forces a rollout. */
  buildRev?: string | null;
  buildRevAnnotation?: string;
}

export function planDirectoryRewrite(files: Map<string, string>, r: DirectoryRewrite): DirectoryPlan {
  const referencing: FileRewrite[] = [];
  for (const name of orderBumpCandidates([...files.keys()].filter(isBumpCandidate))) {
    const original = files.get(name);
    if (original === undefined) continue;
    const result = rewriteImageTag(original, r.project, r.component, r.shortSha, r.digest);
    if (result.matched === 0) continue;
    let { text, changed } = result;
    if (r.buildRev && r.buildRevAnnotation) {
      const rev = rewriteBuildRev(text, r.buildRevAnnotation, r.buildRev);
      text = rev.text;
      changed += rev.changed;
    }
    referencing.push({ ...result, name, text, changed });
  }
  return { toCommit: referencing.filter((f) => f.changed > 0), referencing };
}
