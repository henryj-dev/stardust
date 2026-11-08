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
}

export interface MergeEnvInput {
  /** Reads a repository file by path; null when it does not exist. */
  read: (path: string) => Promise<string | null>;
  /** Decrypts a SOPS document. Not called when `masked`. */
  decrypt?: (document: string) => Promise<string>;
  project: string;
  component: string;
  /** Read encrypted keys without decrypting their values. */
  masked?: boolean;
  /** Where the layers live in the repository. Default DEFAULT_ENV_ROOT. */
  root?: string;
}

function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
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
  return { plain, enc };
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
  for (const layer of layers) {
    for (const scope of ENV_SCOPES) {
      const { plain, enc } = await readLayer(input, layer.key, scope);
      for (const [key, value] of Object.entries(plain)) {
        merged.set(`${scope}:${key}`, {
          scope,
          key,
          value,
          enc: false,
          source: layer.source,
          component: layer.component,
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
        });
      }
    }
  }
  return [...merged.values()];
}
