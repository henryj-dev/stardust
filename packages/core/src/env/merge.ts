/**
 * The environment cascade, read from the deploy repository's env layers:
 *
 *   <root>/_global/<scope>.yaml                 global, plain values
 *   <root>/_global/<scope>.secret.enc.yaml      global, SOPS-encrypted Secret
 *   <root>/<project>/_shared/<scope>.*          the project's shared layer
 *   <root>/<project>/<component>/<scope>.*      one component
 *
 * `<root>` is `deploy/env` unless set (DEFAULT_ENV_ROOT). One deploy
 * repository can hold the layers of several installations, each under its
 * own root, so that one never reads another's global layer.
 *
 * Later layers override earlier ones; within a layer an encrypted value wins
 * over a plain one with the same key. The layout is kept from the
 * predecessor (ADR 0003). One deliberate difference: plain-text secret
 * files (`*.secret.PLAINTEXT.yaml`) are no longer read.
 *
 * References, as Coolify has them: a value may use `${NAME}` (NAME as this
 * component ends up with it) and `{{project.NAME}}` (NAME at the project
 * level: the global and shared layers); `$${` is a literal `${`. They are
 * resolved here, when the values are read in full, so every rendering sees the
 * same. A value listed under `literal:` in its layer's `<scope>.meta.yaml` is
 * kept as it is. A reference to a name that is not set, a cycle, or a plain
 * value that uses a secret (which would put the secret in the ConfigMap in
 * clear) is refused with an EnvReferenceError that names keys, never a value.
 */
import { parse } from "yaml";

export type EnvScope = "build" | "runtime";
export const ENV_SCOPES: readonly EnvScope[] = ["build", "runtime"];
export const MASKED = "[encrypted]";
export const DEFAULT_ENV_ROOT = "deploy/env";

/** A repository-relative directory: no leading or trailing slash, no `.` or `..` segments. */
export function isEnvRoot(root: unknown): root is string {
  if (typeof root !== "string" || root === "" || root.length > 256) return false;
  return root.split("/").every((segment) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment) && segment !== "..");
}

export interface MergedEnv {
  scope: EnvScope;
  key: string;
  /** Plain text, or MASKED for an encrypted value read without decrypting. */
  value: string;
  enc: boolean;
  source: "global" | "project";
  /** "" for global and project-shared values, else the component name. */
  component: string;
  /** Kept as it is: its `${…}` and `{{project.…}}` are not resolved. */
  literal?: boolean;
}

/** A reference that cannot be resolved. The message names keys, never values. */
export class EnvReferenceError extends Error {}

export interface MergeEnvInput {
  /** Reads a repository file by path; null when it does not exist. */
  read: (path: string) => Promise<string | null>;
  /** Decrypts a SOPS document. Not called when `masked`. */
  decrypt?: (document: string) => Promise<string>;
  project: string;
  component: string;
  /** Read encrypted keys without decrypting their values. References are then left as they are. */
  masked?: boolean;
  /** Where the layers live in the repository. Default DEFAULT_ENV_ROOT. */
  root?: string;
}

function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** The names a layer keeps literal, from its `<scope>.meta.yaml`. */
export function literalNames(metaText: string | null): string[] {
  if (metaText === null) return [];
  const meta = parse(metaText) as { literal?: unknown } | null;
  return Array.isArray(meta?.literal) ? meta.literal.map(String) : [];
}

async function readLayer(input: MergeEnvInput, layer: string, scope: EnvScope) {
  const base = `${input.root ?? DEFAULT_ENV_ROOT}/${layer}/${scope}`;
  const plainText = await input.read(`${base}.yaml`);
  const plain = plainText === null ? {} : toStringMap(parse(plainText));
  const encText = await input.read(`${base}.secret.enc.yaml`);
  let enc: Record<string, string> = {};
  if (encText !== null) {
    if (input.masked) {
      const doc = parse(encText) as { stringData?: Record<string, unknown> } | null;
      enc = Object.fromEntries(Object.keys(doc?.stringData ?? {}).map((k) => [k, MASKED]));
    } else {
      if (!input.decrypt) throw new Error(`${base}.secret.enc.yaml needs a decrypt function`);
      const doc = parse(await input.decrypt(encText)) as { stringData?: unknown } | null;
      enc = toStringMap(doc?.stringData);
    }
  }
  const literal = new Set(literalNames(await input.read(`${base}.meta.yaml`)));
  return { plain, enc, literal };
}

const REFERENCE = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{\{\s*project\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Resolves the references of one scope's values. `final` is what the
 * component ends up with, `project` the project-level view of the same scope.
 */
export function resolveReferences(
  final: ReadonlyMap<string, MergedEnv>,
  project: ReadonlyMap<string, MergedEnv>,
): Map<string, string> {
  const memo = { final: new Map<string, string>(), project: new Map<string, string>() };
  const views = { final, project };
  const walk = (where: "final" | "project", key: string, stack: string[]): string => {
    const hit = memo[where].get(key);
    if (hit !== undefined) return hit;
    const label = where === "project" ? `project.${key}` : key;
    const entry = views[where].get(key);
    if (!entry) throw new EnvReferenceError(`${stack.at(-1) ?? label} uses ${label}, which is not set`);
    if (stack.includes(label)) throw new EnvReferenceError(`${[...stack, label].join(" → ")} refer to each other`);
    const out = entry.literal
      ? entry.value
      : entry.value.replace(REFERENCE, (match: string, local?: string, shared?: string) => {
          if (match === "$${") return "${";
          const next: "final" | "project" = local ? "final" : "project";
          const name = (local ?? shared) as string;
          const target = views[next].get(name);
          if (target?.enc && !entry.enc) {
            const used = next === "project" ? `project.${name}` : name;
            throw new EnvReferenceError(
              `${entry.key} is a plain value and uses the secret ${used}: make ${entry.key} a secret, or the secret would be stored in clear`,
            );
          }
          return walk(next, name, [...stack, label]);
        });
    memo[where].set(key, out);
    return out;
  };
  for (const key of final.keys()) walk("final", key, []);
  return memo.final;
}

export async function mergeEnv(input: MergeEnvInput): Promise<MergedEnv[]> {
  if (input.root !== undefined && !isEnvRoot(input.root)) throw new Error(`not a repository directory: ${input.root}`);
  const project = input.project.toLowerCase();
  const layers: Array<{ key: string; source: MergedEnv["source"]; component: string }> = [
    { key: "_global", source: "global", component: "" },
    { key: `${project}/_shared`, source: "project", component: "" },
  ];
  if (input.component)
    layers.push({ key: `${project}/${input.component}`, source: "project", component: input.component });

  const merged = new Map<string, MergedEnv>();
  // What {{project.NAME}} reads: the merge before the component's own layer.
  let projectLevel: Map<string, MergedEnv> | null = null;
  for (const layer of layers) {
    if (layer.component !== "") projectLevel = new Map(merged);
    for (const scope of ENV_SCOPES) {
      const { plain, enc, literal } = await readLayer(input, layer.key, scope);
      const flag = (key: string) => (literal.has(key) ? { literal: true } : {});
      for (const [key, value] of Object.entries(plain)) {
        merged.set(`${scope}:${key}`, {
          scope,
          key,
          value,
          enc: false,
          source: layer.source,
          component: layer.component,
          ...flag(key),
        });
      }
      for (const [key, value] of Object.entries(enc)) {
        merged.set(`${scope}:${key}`, {
          scope,
          key,
          value,
          enc: true,
          source: layer.source,
          component: layer.component,
          ...flag(key),
        });
      }
    }
  }
  // Masked values cannot be resolved: a masked read is for listing names.
  if (input.masked) return [...merged.values()];
  const projectView = projectLevel ?? merged;
  const out: MergedEnv[] = [];
  for (const scope of ENV_SCOPES) {
    const pick = (m: Map<string, MergedEnv>) =>
      new Map([...m.values()].filter((e) => e.scope === scope).map((e) => [e.key, e]));
    const final = pick(merged);
    const resolved = resolveReferences(final, pick(projectView));
    for (const e of final.values()) out.push({ ...e, value: resolved.get(e.key) ?? e.value });
  }
  return out;
}
