/**
 * A component's cluster access, read from and written to its deploy
 * directory: the registry pull Secret its workloads pull with, and the
 * RoleBinding that lets the dashboard read its namespace, and whether its
 * containers read the env page's values as environment variables (see
 * @stardust/core gitops/access). Both are files next to its manifests,
 * listed in its kustomization, so withdrawing the component removes them.
 */
import {
  addResource,
  type BoundRepo,
  commitWithCas,
  envConfigMapName,
  envSecretName,
  findWorkloads,
  type ImageNaming,
  REGISTRY_PULL_FILE,
  type RepoIO,
  RUNTIME_ACCESS_FILE,
  type RuntimeGrant,
  readPullSecrets,
  readsEnv,
  registryPullDocument,
  registryPullSecretName,
  removeResource,
  runtimeBindingDocument,
  type SecretCipher,
  setEnvFrom,
  setPullSecret,
} from "@stardust/core";
import type { Component, Project } from "@stardust/db";
import { parse } from "yaml";

export class AccessInputError extends Error {}
export class AccessConflict extends Error {}

export interface AccessServices {
  images?: ImageNaming;
  /** Seals the pull Secret: without it, pull Secrets are not managed. */
  cipher?: Pick<SecretCipher, "encryptIfChanged">;
  /** Who the dashboard reads the cluster as: without it, pod view is not managed. */
  runtimeGrant?: RuntimeGrant;
}

export interface ComponentAccess {
  /** The namespace the component's workloads run in, if its manifests say. */
  namespace: string | null;
  registryPull: {
    /** Whether stardust can manage it here: a pull login and a cipher are configured. */
    available: boolean;
    on: boolean;
    /** Other pull Secrets the workloads name, such as one made by hand before. */
    others: string[];
  };
  podView: { available: boolean; on: boolean };
  /**
   * Whether every container reads the env ConfigMap and Secret (envFrom), so
   * values set on the env page reach the process. Always manageable.
   */
  envVars: { available: boolean; on: boolean };
}

export interface AccessChange {
  registryPull?: boolean;
  podView?: boolean;
  envVars?: boolean;
}

const envNames = (component: string) => ({
  configMap: envConfigMapName(component),
  secret: envSecretName(component),
});
/** stardust's own files in a deploy directory, which run nothing. */
const ownFile = (path: string) =>
  path.endsWith(`/${REGISTRY_PULL_FILE}`) || path.endsWith(`/${RUNTIME_ACCESS_FILE}`) || /\/env\.[^/]+$/.test(path);

const MANIFEST = /\.ya?ml$/;
const KUSTOMIZATIONS = ["kustomization.yaml", "kustomization.yml"];
const dirOf = (c: Pick<Component, "deployDir">) => c.deployDir.replace(/\/+$/, "");

/** A directory's manifests as `at` has them, path → text. */
async function manifests(at: BoundRepo, dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await at.list(dir)) {
    if (!MANIFEST.test(name)) continue;
    const file = await at.read(`${dir}/${name}`);
    if (file) files.set(`${dir}/${name}`, file.content);
  }
  return files;
}

/** The one namespace the component's workloads run in, or why there is none. */
function namespaceOf(files: ReadonlyMap<string, string>, dir: string): string | { error: string } {
  let fallback: string | null = null;
  for (const k of KUSTOMIZATIONS) {
    const doc = parse(files.get(`${dir}/${k}`) ?? "") as { namespace?: unknown } | null;
    if (typeof doc?.namespace === "string") fallback = doc.namespace;
  }
  const workloads = findWorkloads(files);
  if (workloads.length === 0) return { error: `${dir} has no Deployment, StatefulSet or DaemonSet` };
  const namespaces = new Set(workloads.map((w) => w.namespace ?? fallback));
  if (namespaces.has(null)) return { error: `the manifests in ${dir} name no namespace` };
  if (namespaces.size > 1) return { error: `the workloads in ${dir} run in more than one namespace` };
  return [...namespaces][0] as string;
}

export function accessAvailable(svc: AccessServices) {
  return { registryPull: Boolean(svc.images?.pull && svc.cipher), podView: Boolean(svc.runtimeGrant) };
}

export async function readAccess(repo: RepoIO, component: Component, svc: AccessServices): Promise<ComponentAccess> {
  const head = await repo.headSha();
  const at: BoundRepo = { read: (p) => repo.readFile(p, head), list: (p) => repo.listDir(p, head) };
  const dir = dirOf(component);
  const files = await manifests(at, dir);
  const ns = namespaceOf(files, dir);
  const ours = registryPullSecretName(component.name);
  const named = new Set<string>();
  for (const [path, text] of files) {
    if (path.endsWith(`/${REGISTRY_PULL_FILE}`)) continue;
    try {
      for (const n of readPullSecrets(text)) named.add(n);
    } catch {
      // An unparseable manifest names nothing stardust can tell.
    }
  }
  const reads: boolean[] = [];
  for (const [path, text] of files) {
    if (ownFile(path)) continue;
    try {
      const r = readsEnv(text, envNames(component.name));
      if (r !== null) reads.push(r);
    } catch {
      // As above.
    }
  }
  const available = accessAvailable(svc);
  return {
    namespace: typeof ns === "string" ? ns : null,
    registryPull: {
      available: available.registryPull,
      on: files.has(`${dir}/${REGISTRY_PULL_FILE}`) && named.has(ours),
      others: [...named].filter((n) => n !== ours).sort(),
    },
    podView: { available: available.podView, on: files.has(`${dir}/${RUNTIME_ACCESS_FILE}`) },
    envVars: { available: true, on: reads.length > 0 && reads.every(Boolean) },
  };
}

/**
 * The changes (path → new text, or null to delete) that give a component the
 * access asked for, at `at`: files written or removed, the kustomization
 * listing them, and the workloads naming the pull Secret. Used for an
 * existing directory and for one being scaffolded alike.
 */
export async function planAccess(
  at: BoundRepo,
  component: Pick<Component, "name" | "deployDir">,
  change: AccessChange,
  svc: AccessServices,
): Promise<Map<string, string | null>> {
  const dir = dirOf(component);
  const files = await manifests(at, dir);
  const out = new Map<string, string | null>();
  const available = accessAvailable(svc);
  if (change.registryPull && !available.registryPull) {
    throw new AccessInputError(
      "managing pull Secrets needs a pull login (plugins.builder-buildkit.pull) and a cipher (secrets-sops-age)",
    );
  }
  if (change.podView && !available.podView) {
    throw new AccessInputError("managing pod view needs the chart's runtime ClusterRole (runtime.bindings)");
  }
  const wantsFiles = change.registryPull === true || change.podView === true;
  const ns = namespaceOf(files, dir);
  if (wantsFiles && typeof ns !== "string") throw new AccessInputError(ns.error);
  const kustomization = KUSTOMIZATIONS.map((k) => `${dir}/${k}`).find((p) => files.has(p));
  let listing = kustomization ? (files.get(kustomization) ?? "") : null;
  const list = (name: string, on: boolean) => {
    if (listing === null) {
      if (on) throw new AccessInputError(`${dir} has no kustomization.yaml to list ${name} in`);
      return;
    }
    try {
      listing = on ? addResource(listing, name) : removeResource(listing, name);
    } catch (err) {
      throw new AccessInputError(`${kustomization}: ${(err as Error).message}`);
    }
  };

  if (change.registryPull !== undefined) {
    const path = `${dir}/${REGISTRY_PULL_FILE}`;
    const secretName = registryPullSecretName(component.name);
    if (change.registryPull) {
      const pull = svc.images?.pull as NonNullable<ImageNaming["pull"]>;
      const login = await pull.login();
      const plain = registryPullDocument({
        component: component.name,
        namespace: ns as string,
        login: { host: pull.host, ...login },
      });
      const sealed = await (svc.cipher as NonNullable<AccessServices["cipher"]>).encryptIfChanged(
        files.get(path) ?? null,
        plain,
      );
      if (sealed.changed || !files.has(path)) out.set(path, sealed.document);
    } else if (files.has(path)) {
      out.set(path, null);
    }
    list(REGISTRY_PULL_FILE, change.registryPull);
    for (const [p, text] of files) {
      if (p === path || p === kustomization) continue;
      let edited: ReturnType<typeof setPullSecret>;
      try {
        edited = setPullSecret(text, secretName, change.registryPull);
      } catch (err) {
        throw new AccessInputError(`${p}: ${(err as Error).message}`);
      }
      if (edited.changed) out.set(p, edited.text);
    }
  }

  if (change.podView !== undefined) {
    const path = `${dir}/${RUNTIME_ACCESS_FILE}`;
    if (change.podView) {
      const text = runtimeBindingDocument({
        component: component.name,
        namespace: ns as string,
        grant: svc.runtimeGrant as RuntimeGrant,
      });
      if (files.get(path) !== text) out.set(path, text);
    } else if (files.has(path)) {
      out.set(path, null);
    }
    list(RUNTIME_ACCESS_FILE, change.podView);
  }

  if (change.envVars !== undefined) {
    let workloads = 0;
    for (const [p, text] of files) {
      if (ownFile(p) || p === kustomization) continue;
      let edited: ReturnType<typeof setEnvFrom>;
      try {
        edited = setEnvFrom(out.get(p) ?? text, envNames(component.name), change.envVars);
      } catch (err) {
        throw new AccessInputError(`${p}: ${(err as Error).message}`);
      }
      workloads += edited.workloads;
      if (edited.changed) out.set(p, edited.text);
    }
    if (change.envVars && workloads === 0) {
      throw new AccessInputError(`${dir} has no Deployment, StatefulSet or DaemonSet to read the env`);
    }
  }

  if (kustomization && listing !== null && listing !== files.get(kustomization)) out.set(kustomization, listing);
  return out;
}

const ACCESS_LABEL: Record<keyof AccessChange, string> = {
  registryPull: "registry pull",
  podView: "pod view",
  envVars: "env variables",
};

const conflictOrThrow = (result: Awaited<ReturnType<typeof commitWithCas>>, what: string) => {
  if (result.status !== "error") return;
  if (result.kind === "stale_head" || result.kind === "ref_race") {
    throw new AccessConflict("the deploy repository kept changing; try again");
  }
  throw new Error(`committing ${what} failed: ${result.message}`);
};

/** Changes a component's access as one commit. */
export async function writeAccess(
  repo: RepoIO,
  input: { project: string; component: Component; change: AccessChange; by: string },
  svc: AccessServices,
): Promise<{ status: "committed" | "no_change"; commit: string | null }> {
  const result = await commitWithCas(repo, async (_head, at) => {
    const files = await planAccess(at, input.component, input.change, svc);
    if (files.size === 0) return null;
    const what = Object.entries(input.change)
      .map(([k, v]) => `${ACCESS_LABEL[k as keyof AccessChange]} ${v ? "on" : "off"}`)
      .join(", ");
    return { files, message: `chore(${input.project}/${input.component.name}): ${what}\n\nBy ${input.by}.` };
  });
  conflictOrThrow(result, "the access");
  return {
    status: result.status === "committed" ? "committed" : "no_change",
    commit: result.status === "committed" ? result.sha : null,
  };
}

/**
 * Seals the current pull login into every component that has a pull Secret,
 * as one commit: after the login changes, every namespace pulls with the new
 * one. A Secret that already holds it keeps its bytes.
 */
export async function resealPulls(
  repo: RepoIO,
  projects: readonly Project[],
  svc: AccessServices,
  by: string,
): Promise<{ status: "committed" | "no_change"; commit: string | null; components: string[] }> {
  if (!accessAvailable(svc).registryPull) {
    throw new AccessInputError(
      "managing pull Secrets needs a pull login (plugins.builder-buildkit.pull) and a cipher (secrets-sops-age)",
    );
  }
  let components: string[] = [];
  const result = await commitWithCas(repo, async (_head, at) => {
    const files = new Map<string, string | null>();
    components = [];
    for (const project of projects) {
      for (const component of project.components) {
        const dir = dirOf(component);
        if (!(await at.list(dir)).includes(REGISTRY_PULL_FILE)) continue;
        components.push(`${project.id}/${component.name}`);
        for (const [p, text] of await planAccess(at, component, { registryPull: true }, svc)) {
          if (p.endsWith(`/${REGISTRY_PULL_FILE}`)) files.set(p, text);
        }
      }
    }
    if (files.size === 0) return null;
    return { files, message: `chore: reseal registry pull Secrets (${files.size})\n\nBy ${by}.` };
  });
  conflictOrThrow(result, "the pull Secrets");
  return {
    status: result.status === "committed" ? "committed" : "no_change",
    commit: result.status === "committed" ? result.sha : null,
    components,
  };
}
