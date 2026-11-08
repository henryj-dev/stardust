/**
 * Editing a project's environment: the env layers in the deploy repository,
 * and the ConfigMap and Secret rendered from them next to each component's
 * manifests.
 *
 *   <root>/<project>/_shared/runtime.yaml               plain values, every component
 *   <root>/<project>/_shared/runtime.secret.enc.yaml    SOPS-encrypted values, every component
 *   <root>/<project>/<component>/runtime.*              one component
 *   <deployDir>/env.configmap.yaml, env.secret.enc.yaml rendered (core renderEnv)
 *
 * `<root>` is `deploy/env` unless gitops-git's `envRoot` says otherwise.
 *
 * One change is one commit, made with compare-and-swap on the branch head:
 * the layer as the editor read it (its revision) must still be the layer at
 * the head, or the change is refused as a conflict instead of overwriting
 * someone else's. The commit also writes the env revision into the pod
 * template of the workloads that use the env, so the GitOps controller rolls
 * them out; a restart done on the cluster would be reverted as drift.
 *
 * Secret values only go one way: into a SOPS document. Nothing here returns
 * them, logs them or puts them in a commit message — reads list secret names.
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_ENV_ROOT,
  ENV_REVISION_ANNOTATION,
  envConfigMapName,
  envSecretName,
  type MergedEnv,
  mergeEnv,
  renderEnv,
} from "@stardust/core";
import type { Component, Project } from "@stardust/db";
import {
  addResource,
  type BoundRepo,
  type CasOptions,
  commitWithCas,
  type PendingCommit,
  type RepoIO,
  stampPodTemplate,
} from "@stardust/plugin-gitops-git";
import { Document, isMap, parse, parseAllDocuments, parseDocument } from "yaml";

/** SOPS, as the editor needs it: decrypt a document, and encrypt one unless it decrypts to the same. */
export interface EnvCodec {
  decrypt(document: string): Promise<string>;
  encryptIfChanged(current: string | null, plain: string): Promise<{ changed: boolean; document: string }>;
}

export interface EnvEditor {
  repo: RepoIO;
  codec: EnvCodec;
  /** Keys the env revision fingerprint, so a revision says nothing about the values. */
  revisionKey: string;
  cas?: CasOptions;
  /** Where the env layers live in the deploy repository. Default DEFAULT_ENV_ROOT. */
  root?: string;
}

/** The layer every component of a project reads. Other layers are named after a component. */
export const SHARED_LAYER = "_shared";

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_ENV_VALUE = 32 * 1024;
export const MAX_ENV_CHANGES = 100;

export class EnvInputError extends Error {}
export class EnvConflict extends Error {}

export interface EnvLayerView {
  layer: string;
  /** Pass back as `expectedRevision` to change this layer. */
  revision: string;
  plain: Record<string, string>;
  /** Names only: secret values are never read back. */
  secrets: string[];
}

export interface EnvChange {
  expectedRevision: string;
  set?: Record<string, string>;
  unset?: string[];
  setSecrets?: Record<string, string>;
  unsetSecrets?: string[];
}

export interface EnvChangeResult {
  status: "committed" | "no_change";
  commit: string | null;
  /** The layer's revision after the change. */
  revision: string;
  components: Array<{
    name: string;
    /** The rendered env's revision, as written to the ConfigMap, the Secret and the pod templates. */
    envRevision: string;
    /** Workloads that use the env and were stamped to roll out. Empty: nothing uses it yet. */
    consumers: string[];
  }>;
}

const layerBase = (root: string | undefined, project: string, layer: string) =>
  `${root ?? DEFAULT_ENV_ROOT}/${project.toLowerCase()}/${layer}/runtime`;
const plainPath = (root: string | undefined, project: string, layer: string) =>
  `${layerBase(root, project, layer)}.yaml`;
const secretPath = (root: string | undefined, project: string, layer: string) =>
  `${layerBase(root, project, layer)}.secret.enc.yaml`;
const dirOf = (c: Component) => c.deployDir.replace(/\/+$/, "");

function layerRevision(plainText: string | null, secretText: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify([plainText, secretText]))
    .digest("hex")
    .slice(0, 20);
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** Secret names in an encrypted layer, read without decrypting: SOPS leaves keys readable. */
function secretNames(secretText: string | null): string[] {
  if (secretText === null) return [];
  const doc = parse(secretText) as { stringData?: Record<string, unknown> } | null;
  return Object.keys(doc?.stringData ?? {}).sort();
}

export function layersOf(project: Project): string[] {
  return [SHARED_LAYER, ...project.components.map((c) => c.name)];
}

// One operation at a time per repository: the git command line keeps one
// local clone, and two fetches into it at once fail on its lock.
const queues = new WeakMap<RepoIO, Promise<unknown>>();
function serially<T>(repo: RepoIO, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(repo) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(
    repo,
    next.catch(() => {}),
  );
  return next;
}

/** Every editable layer of a project, with plain values and secret names. */
export function readEnv(editor: EnvEditor, project: Project): Promise<{ head: string; layers: EnvLayerView[] }> {
  return serially(editor.repo, () => readLayers(editor, project));
}

async function readLayers(editor: EnvEditor, project: Project): Promise<{ head: string; layers: EnvLayerView[] }> {
  const head = await editor.repo.headSha();
  const layers: EnvLayerView[] = [];
  for (const layer of layersOf(project)) {
    const plainText = (await editor.repo.readFile(plainPath(editor.root, project.id, layer), head))?.content ?? null;
    const secretText = (await editor.repo.readFile(secretPath(editor.root, project.id, layer), head))?.content ?? null;
    layers.push({
      layer,
      revision: layerRevision(plainText, secretText),
      plain: plainText === null ? {} : stringMap(parse(plainText)),
      secrets: secretNames(secretText),
    });
  }
  return { head, layers };
}

/** Checks a change before anything is read; the reason is safe to show (it names keys, never values). */
export function checkChange(change: unknown): EnvChange {
  if (!change || typeof change !== "object" || Array.isArray(change))
    throw new EnvInputError("a JSON object is required");
  const c = change as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!["expectedRevision", "set", "unset", "setSecrets", "unsetSecrets"].includes(key))
      throw new EnvInputError(`unknown field "${key}"`);
  }
  if (typeof c.expectedRevision !== "string" || !/^[0-9a-f]{20}$/.test(c.expectedRevision))
    throw new EnvInputError("expectedRevision is required: the revision of the layer as you read it");
  const map = (field: string): Record<string, string> => {
    const v = c[field];
    if (v === undefined) return {};
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new EnvInputError(`${field} must be an object of names to values`);
    for (const [k, val] of Object.entries(v)) {
      if (!ENV_KEY.test(k)) throw new EnvInputError(`"${k.slice(0, 130)}" is not an environment variable name`);
      if (typeof val !== "string") throw new EnvInputError(`${field}.${k} must be text`);
      if (Buffer.byteLength(val) > MAX_ENV_VALUE) throw new EnvInputError(`${field}.${k} is longer than 32 KiB`);
    }
    return v as Record<string, string>;
  };
  const list = (field: string): string[] => {
    const v = c[field];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new EnvInputError(`${field} must be a list of names`);
    for (const k of v) {
      if (typeof k !== "string" || !ENV_KEY.test(k))
        throw new EnvInputError(`${field}: "${String(k).slice(0, 130)}" is not an environment variable name`);
    }
    return v as string[];
  };
  const out: EnvChange = {
    expectedRevision: c.expectedRevision,
    set: map("set"),
    unset: list("unset"),
    setSecrets: map("setSecrets"),
    unsetSecrets: list("unsetSecrets"),
  };
  const names = [
    ...Object.keys(out.set ?? {}),
    ...(out.unset ?? []),
    ...Object.keys(out.setSecrets ?? {}),
    ...(out.unsetSecrets ?? []),
  ];
  if (names.length === 0) throw new EnvInputError("nothing to change");
  if (names.length > MAX_ENV_CHANGES) throw new EnvInputError(`at most ${MAX_ENV_CHANGES} changes at once`);
  if (new Set(names).size !== names.length) throw new EnvInputError("each name may appear once in a change");
  return out;
}

/** A plain layer file, keeping its comments and order; new keys go at the end. */
function writePlain(current: string | null, values: Record<string, string>): string | null {
  if (Object.keys(values).length === 0) return null;
  // A new file starts as a block mapping; an empty `{}` would stay in flow style.
  if (current === null) return new Document(values).toString();
  const doc = parseDocument(current);
  if (!isMap(doc.contents)) throw new Error("the plain env layer is not a mapping");
  for (const item of [...doc.contents.items]) {
    const key = String((item.key as { value?: unknown })?.value ?? item.key);
    if (!(key in values)) doc.delete(key);
  }
  for (const [k, v] of Object.entries(values)) {
    if (doc.get(k) !== v) doc.set(k, v);
  }
  return doc.toString();
}

/** The plain-text Secret document an encrypted layer holds. Keys and values as JSON strings, like rendered files. */
function secretDocument(values: Record<string, string>): string {
  const lines = ["apiVersion: v1", "kind: Secret", "metadata:", "  name: placeholder", "type: Opaque", "stringData:"];
  const pairs = Object.entries(values);
  if (pairs.length === 0) lines.push("  {}");
  for (const [k, v] of pairs) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `${lines.join("\n")}\n`;
}

/** The namespace a component's manifests deploy to: a workload's, else the kustomization's. */
async function namespaceOf(at: BoundRepo, dir: string): Promise<string> {
  for (const name of await at.list(dir)) {
    if (!/\.ya?ml$/.test(name) || name.startsWith("env.")) continue;
    const text = (await at.read(`${dir}/${name}`))?.content ?? "";
    for (const doc of parseAllDocuments(text)) {
      if (doc.errors.length > 0) continue;
      const ns = doc.getIn(["metadata", "namespace"]);
      if (["Deployment", "StatefulSet", "DaemonSet"].includes(String(doc.get("kind"))) && typeof ns === "string")
        return ns;
    }
  }
  const kustomization = (await at.read(`${dir}/kustomization.yaml`))?.content;
  const ns = kustomization ? (parse(kustomization) as { namespace?: unknown } | null)?.namespace : undefined;
  if (typeof ns === "string") return ns;
  throw new EnvInputError(`cannot tell which namespace ${dir} deploys to: no workload or kustomization names one`);
}

/** Whether a workload document reads the ConfigMap or the Secret, by env, envFrom or volume. */
function usesEnv(workload: unknown, configMap: string, secret: string): boolean {
  const spec = (workload as { spec?: { template?: { spec?: Record<string, unknown> } } })?.spec?.template?.spec;
  if (!spec) return false;
  type C = {
    envFrom?: Array<{ secretRef?: { name?: string }; configMapRef?: { name?: string } }>;
    env?: Array<{ valueFrom?: { secretKeyRef?: { name?: string }; configMapKeyRef?: { name?: string } } }>;
  };
  const containers = [...((spec.containers as C[]) ?? []), ...((spec.initContainers as C[]) ?? [])];
  const volumes = (spec.volumes as Array<{ secret?: { secretName?: string }; configMap?: { name?: string } }>) ?? [];
  return (
    containers.some(
      (c) =>
        c.envFrom?.some((e) => e.secretRef?.name === secret || e.configMapRef?.name === configMap) ||
        c.env?.some(
          (e) => e.valueFrom?.secretKeyRef?.name === secret || e.valueFrom?.configMapKeyRef?.name === configMap,
        ),
    ) || volumes.some((v) => v.secret?.secretName === secret || v.configMap?.name === configMap)
  );
}

/**
 * Applies a change to one layer as one commit: the layer files, the rendered
 * env of every component that reads the layer, the kustomization lists, and
 * the pod template stamps.
 */
export function changeEnv(
  editor: EnvEditor,
  project: Project,
  layer: string,
  change: EnvChange,
  by: string,
): Promise<EnvChangeResult> {
  if (!layersOf(project).includes(layer))
    return Promise.reject(new EnvInputError(`"${layer}" is not a layer of this project`));
  return serially(editor.repo, () => applyChange(editor, project, layer, change, by));
}

async function applyChange(
  editor: EnvEditor,
  project: Project,
  layer: string,
  change: EnvChange,
  by: string,
): Promise<EnvChangeResult> {
  const components = layer === SHARED_LAYER ? project.components : project.components.filter((c) => c.name === layer);
  let outcome: Omit<EnvChangeResult, "status" | "commit"> | null = null;

  const result = await commitWithCas(
    editor.repo,
    async (_head, at) => {
      const pPath = plainPath(editor.root, project.id, layer);
      const sPath = secretPath(editor.root, project.id, layer);
      const plainText = (await at.read(pPath))?.content ?? null;
      const secretText = (await at.read(sPath))?.content ?? null;
      if (layerRevision(plainText, secretText) !== change.expectedRevision) {
        throw new EnvConflict("the env changed since you read it; reload it and make your change again");
      }

      const plain = plainText === null ? {} : stringMap(parse(plainText));
      const secrets =
        secretText === null
          ? {}
          : stringMap((parse(await editor.codec.decrypt(secretText)) as { stringData?: unknown } | null)?.stringData);
      // A name is plain or secret in a layer, not both: setting one removes the other.
      for (const k of change.unset ?? []) delete plain[k];
      for (const k of change.unsetSecrets ?? []) delete secrets[k];
      for (const [k, v] of Object.entries(change.set ?? {})) {
        plain[k] = v;
        delete secrets[k];
      }
      for (const [k, v] of Object.entries(change.setSecrets ?? {})) {
        secrets[k] = v;
        delete plain[k];
      }

      const files: PendingCommit = new Map();
      const newPlain = writePlain(plainText, plain);
      if (newPlain !== plainText) files.set(pPath, newPlain);
      let newSecret: string | null = null;
      if (Object.keys(secrets).length > 0) {
        newSecret = (await editor.codec.encryptIfChanged(secretText, secretDocument(secrets))).document;
      }
      if (newSecret !== secretText) files.set(sPath, newSecret);

      // Reads see this change already: the rendered env is made from the layers as they will be.
      const read = async (path: string) =>
        files.has(path) ? (files.get(path) ?? null) : ((await at.read(path))?.content ?? null);
      const rendered: Array<{ name: string; envRevision: string; consumers: string[] }> = [];
      for (const component of components) {
        const dir = dirOf(component);
        const merged: MergedEnv[] = await mergeEnv({
          read,
          decrypt: (d) => editor.codec.decrypt(d),
          project: project.id,
          ...(editor.root ? { root: editor.root } : {}),
          component: component.name,
        });
        const env = renderEnv({
          merged,
          component: component.name,
          namespace: await namespaceOf(at, dir),
          revisionKey: editor.revisionKey,
        });
        const cmPath = `${dir}/env.configmap.yaml`;
        if ((await read(cmPath)) !== env.configMapYaml) files.set(cmPath, env.configMapYaml);
        const secPath = `${dir}/env.secret.enc.yaml`;
        const current = await read(secPath);
        const sealed = await editor.codec.encryptIfChanged(current, env.secretYaml);
        if (sealed.changed) files.set(secPath, sealed.document);

        const kPath = `${dir}/kustomization.yaml`;
        const kustomization = await read(kPath);
        if (kustomization !== null) {
          const listed = addResource(addResource(kustomization, "env.configmap.yaml"), "env.secret.enc.yaml");
          if (listed !== kustomization) files.set(kPath, listed);
        }

        const consumers: string[] = [];
        for (const name of await at.list(dir)) {
          if (!/\.ya?ml$/.test(name) || name.startsWith("env.") || name === "kustomization.yaml") continue;
          const path = `${dir}/${name}`;
          const text = (await read(path)) ?? "";
          const users = parseAllDocuments(text)
            .filter((d) => d.errors.length === 0)
            .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string } })
            .filter((w) => usesEnv(w, envConfigMapName(component.name), envSecretName(component.name)));
          if (users.length === 0) continue;
          consumers.push(...users.map((w) => `${w.kind}/${w.metadata?.name ?? "?"}`));
          const stamped = stampPodTemplate(text, ENV_REVISION_ANNOTATION, env.revision);
          if (stamped.changed) files.set(path, stamped.text);
        }
        rendered.push({ name: component.name, envRevision: env.revision, consumers });
      }

      outcome = {
        revision: layerRevision(
          files.has(pPath) ? (files.get(pPath) ?? null) : plainText,
          files.has(sPath) ? (files.get(sPath) ?? null) : secretText,
        ),
        components: rendered,
      };
      if (files.size === 0) return null;
      return { files, message: commitMessage(project.id, layer, change, by) };
    },
    editor.cas,
  );

  if (result.status === "error") {
    if (result.kind === "stale_head" || result.kind === "ref_race")
      throw new EnvConflict("the deploy repository kept changing; try again");
    throw new Error(`committing the env change failed: ${result.message}`);
  }
  const done = outcome as Omit<EnvChangeResult, "status" | "commit"> | null;
  if (!done) throw new Error("the env change was not planned");
  return {
    status: result.status,
    commit: result.status === "committed" ? result.sha : null,
    ...done,
  };
}

/** Names what changed, never a value. */
export function commitMessage(project: string, layer: string, change: EnvChange, by: string): string {
  const parts: string[] = [];
  const names = (o?: Record<string, string>) => Object.keys(o ?? {});
  if (names(change.set).length) parts.push(`set ${names(change.set).join(", ")}`);
  if (change.unset?.length) parts.push(`unset ${change.unset.join(", ")}`);
  if (names(change.setSecrets).length) parts.push(`set secrets ${names(change.setSecrets).join(", ")}`);
  if (change.unsetSecrets?.length) parts.push(`unset secrets ${change.unsetSecrets.join(", ")}`);
  return `chore(env): ${project}/${layer} — ${parts.join("; ")}\n\nChanged by ${by} in stardust.`;
}
