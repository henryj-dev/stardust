/**
 * The environment cascade, read from the deploy repository's env layers:
 *
 *   deploy/env/_global/<scope>.yaml                 global, plain values
 *   deploy/env/_global/<scope>.secret.enc.yaml      global, SOPS-encrypted Secret
 *   deploy/env/<project>/_shared/<scope>.*          the project's shared layer
 *   deploy/env/<project>/<component>/<scope>.*      one component
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
}

function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

async function readLayer(input: MergeEnvInput, layer: string, scope: EnvScope) {
  const base = `deploy/env/${layer}/${scope}`;
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
