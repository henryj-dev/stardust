/**
 * A component's env made by hand before stardust managed it: a ConfigMap
 * `<component>-env` or a Secret `<component>-env-secret` in another file of
 * its deploy directory. stardust renders objects with those names, so the two
 * cannot both be listed: kustomize refuses the duplicate and the whole
 * directory stops applying.
 *
 * Adopting moves them into the component's env layer, as one commit with the
 * change that needed it: their values become the layer's (a value already in
 * the layer wins), and their documents leave the file they were in; a file
 * left empty is removed and unlisted. A SOPS file holding several documents
 * has one MAC over all of them, so it is decrypted whole and what is left is
 * encrypted again: the other Secrets keep their values, not their bytes.
 */
import { type BoundRepo, envConfigMapName, envSecretName, removeResource } from "@stardust/core";
import { parse } from "yaml";
import { EnvInputError } from "./env-errors.ts";

/** What adopting would move: names only, never a value. */
export interface HandEnv {
  path: string;
  kind: "ConfigMap" | "Secret";
  name: string;
  keys: string[];
}

const RENDERED = new Set(["env.configmap.yaml", "env.secret.enc.yaml"]);
const KUSTOMIZATIONS = new Set(["kustomization.yaml", "kustomization.yml"]);

/** A file's YAML documents as text, in order, without their `---` lines. */
export function splitDocuments(text: string): string[] {
  const docs: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (/^---\s*$/.test(line)) {
      docs.push(current.join("\n"));
      current = [];
    } else current.push(line);
  }
  docs.push(current.join("\n"));
  return docs.filter((d) => d.trim() !== "");
}

const joinDocuments = (docs: string[]) => docs.map((d) => `${d.replace(/\n*$/, "")}\n`).join("---\n");

type Doc = {
  kind?: unknown;
  type?: unknown;
  metadata?: { name?: unknown; namespace?: unknown };
  data?: unknown;
  stringData?: unknown;
  sops?: unknown;
};

const keysOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);

/** The hand-made env documents in a directory, read at `at` (through `read`, which may hold pending changes). */
export async function findHandEnv(
  at: Pick<BoundRepo, "list">,
  read: (path: string) => Promise<string | null>,
  dir: string,
  component: string,
  namespace: string,
): Promise<Array<HandEnv & { index: number }>> {
  const wanted = { ConfigMap: envConfigMapName(component), Secret: envSecretName(component) };
  const found: Array<HandEnv & { index: number }> = [];
  for (const file of await at.list(dir)) {
    if (!/\.ya?ml$/.test(file) || RENDERED.has(file) || KUSTOMIZATIONS.has(file)) continue;
    const path = `${dir}/${file}`;
    const text = await read(path);
    if (text === null) continue;
    for (const [index, chunk] of splitDocuments(text).entries()) {
      let doc: Doc | null;
      try {
        doc = parse(chunk) as Doc | null;
      } catch {
        continue;
      }
      const kind = doc?.kind;
      if (kind !== "ConfigMap" && kind !== "Secret") continue;
      if (doc?.metadata?.name !== wanted[kind]) continue;
      const ns = doc.metadata?.namespace;
      if (ns !== undefined && ns !== namespace) continue;
      found.push({
        path,
        kind,
        name: wanted[kind],
        keys: [...keysOf(doc.data), ...keysOf(doc.stringData)].sort(),
        index,
      });
    }
  }
  return found;
}

const text = (value: unknown, where: string): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new EnvInputError(`${where} is not a text value`);
};

/** A Secret's `data` value, decoded: only text can become an env value. */
const decoded = (value: unknown, where: string): string => {
  const b64 = text(value, where).replace(/\s+/g, "");
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new EnvInputError(`${where} is not base64`);
  const out = Buffer.from(b64, "base64");
  const s = out.toString("utf8");
  if (Buffer.from(s, "utf8").compare(out) !== 0) throw new EnvInputError(`${where} is not UTF-8 text`);
  return s;
};

export interface Adoption {
  /** File changes: the file without the adopted documents, or null when nothing is left. */
  files: Map<string, string | null>;
  /** The kustomization without the removed files, when any was removed. */
  kustomization: string | null;
  plain: Record<string, string>;
  secrets: Record<string, string>;
  from: HandEnv[];
}

/**
 * Reads the values of the hand-made env documents and plans their removal.
 * Nothing here returns a value to a caller outside the env editor.
 */
export async function adoptHandEnv(
  at: Pick<BoundRepo, "list">,
  read: (path: string) => Promise<string | null>,
  input: {
    dir: string;
    component: string;
    namespace: string;
    decrypt: (doc: string) => Promise<string>;
    encrypt: (plain: string) => Promise<string>;
  },
): Promise<Adoption | null> {
  const found = await findHandEnv(at, read, input.dir, input.component, input.namespace);
  if (found.length === 0) return null;
  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const files = new Map<string, string | null>();
  const byFile = new Map<string, Set<number>>();
  for (const h of found) byFile.set(h.path, (byFile.get(h.path) ?? new Set()).add(h.index));

  for (const [path, indices] of byFile) {
    const original = (await read(path)) ?? "";
    const raw = splitDocuments(original);
    const sealed = raw.some((d) => (parse(d) as Doc | null)?.sops !== undefined);
    // One MAC covers every document of a SOPS file: decrypt it whole, never a document alone.
    let docs = raw;
    if (sealed) {
      try {
        docs = splitDocuments(await input.decrypt(original));
      } catch {
        // Made by hand, it is often encrypted only to the cluster's and the operator's keys.
        throw new EnvInputError(
          `stardust cannot decrypt ${path} to adopt ${[...indices].map((i) => found.find((h) => h.path === path && h.index === i)?.name).join(", ")}: the file is not encrypted to stardust's key. Add stardust's age recipient to it (sops updatekeys, or encrypt it again with that recipient too), or move the env Secret to a file of its own encrypted to it, and try again`,
        );
      }
    }
    if (docs.length !== raw.length) throw new Error(`${path}: decrypting changed the number of documents`);
    for (const index of indices) {
      const doc = parse(docs[index] ?? "") as Doc;
      const at = `${path} (${String(doc.kind)} ${String(doc.metadata?.name)})`;
      if (doc.kind === "Secret" && doc.type !== undefined && doc.type !== "Opaque")
        throw new EnvInputError(`${at} is a ${String(doc.type)} Secret, not env values; rename it before adopting`);
      const into = doc.kind === "Secret" ? secrets : plain;
      const data = doc.data && typeof doc.data === "object" ? (doc.data as Record<string, unknown>) : {};
      const stringData =
        doc.stringData && typeof doc.stringData === "object" ? (doc.stringData as Record<string, unknown>) : {};
      for (const [k, v] of Object.entries(data))
        into[k] = doc.kind === "Secret" ? decoded(v, `${at} ${k}`) : text(v, `${at} ${k}`);
      for (const [k, v] of Object.entries(stringData)) into[k] = text(v, `${at} ${k}`);
    }
    const left = docs.filter((_, i) => !indices.has(i));
    if (left.length === 0) files.set(path, null);
    else if (sealed) files.set(path, await input.encrypt(joinDocuments(left)));
    else files.set(path, joinDocuments(raw.filter((_, i) => !indices.has(i))));
  }

  let kustomization: string | null = null;
  const removed = [...files].filter(([, v]) => v === null).map(([p]) => p.slice(input.dir.length + 1));
  if (removed.length > 0) {
    const kPath = `${input.dir}/kustomization.yaml`;
    const current = await read(kPath);
    if (current !== null) {
      let next = current;
      for (const name of removed) next = removeResource(next, name);
      if (next !== current) kustomization = next;
    }
  }
  return { files, kustomization, plain, secrets, from: found.map(({ index: _, ...h }) => h) };
}
