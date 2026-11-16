/**
 * Which env secrets a component reads as files, read from and written to its
 * deploy directory. The keys come from the component's rendered env Secret
 * (`env.secret.enc.yaml`): SOPS leaves the keys in clear, so nothing is
 * decrypted, and a key is only mounted if the Secret has it.
 */
import {
  type BoundRepo,
  commitWithCas,
  envSecretName,
  type FileMount,
  type RepoIO,
  readFileMounts,
  setFileMounts,
} from "@stardust/core";
import type { Component } from "@stardust/db";
import { parse } from "yaml";

export class FilesInputError extends Error {}
export class FilesConflict extends Error {}

const dirOf = (c: Component) => c.deployDir.replace(/\/+$/, "");

/** The manifests in a component's directory that are its own, not ones stardust renders. */
async function workloadFiles(at: BoundRepo, dir: string): Promise<string[]> {
  return (await at.list(dir))
    .filter((name) => /\.ya?ml$/.test(name) && !name.startsWith("env.") && name !== "kustomization.yaml")
    .map((name) => `${dir}/${name}`);
}

/** The keys of the component's env Secret, without decrypting it. */
async function secretKeys(at: BoundRepo, dir: string): Promise<string[]> {
  const text = (await at.read(`${dir}/env.secret.enc.yaml`))?.content;
  if (!text) return [];
  const doc = parse(text) as { stringData?: Record<string, unknown> } | null;
  return Object.keys(doc?.stringData ?? {}).sort();
}

export interface ComponentFiles {
  mounts: FileMount[];
  /** Env secrets this component reads, any of which can be mounted. */
  secrets: string[];
}

export async function readFiles(repo: RepoIO, component: Component): Promise<ComponentFiles> {
  const head = await repo.headSha();
  const at: BoundRepo = { read: (path) => repo.readFile(path, head), list: (path) => repo.listDir(path, head) };
  const dir = dirOf(component);
  const mounts: FileMount[] = [];
  for (const path of await workloadFiles(at, dir)) {
    const text = (await at.read(path))?.content ?? "";
    for (const m of readFileMounts(text, component.name)) {
      if (!mounts.some((x) => x.path === m.path)) mounts.push(m);
    }
  }
  return { mounts, secrets: await secretKeys(at, dir) };
}

/**
 * Sets the files a component mounts, as one commit. Every key must be a
 * secret the component reads, so a pod never waits on a key that is not
 * there; there must be a workload to mount into.
 */
export async function writeFiles(
  repo: RepoIO,
  input: { project: string; component: Component; mounts: FileMount[]; by: string },
): Promise<{ status: "committed" | "no_change"; commit: string | null }> {
  const dir = dirOf(input.component);
  const result = await commitWithCas(repo, async (_head, at) => {
    const known = new Set(await secretKeys(at, dir));
    const missing = input.mounts.filter((m) => !known.has(m.key)).map((m) => m.key);
    if (missing.length > 0) {
      throw new FilesInputError(
        `${[...new Set(missing)].join(", ")} ${missing.length === 1 ? "is not a secret" : "are not secrets"} ${input.component.name} reads: set ${missing.length === 1 ? "it" : "them"} on the env page first`,
      );
    }
    const files = new Map<string, string>();
    let workloads = 0;
    for (const path of await workloadFiles(at, dir)) {
      const text = (await at.read(path))?.content ?? "";
      let edited: ReturnType<typeof setFileMounts>;
      try {
        edited = setFileMounts(text, {
          component: input.component.name,
          secretName: envSecretName(input.component.name),
          mounts: input.mounts,
        });
      } catch (err) {
        throw new FilesInputError(`${path}: ${(err as Error).message}`);
      }
      workloads += edited.workloads;
      if (edited.changed) files.set(path, edited.text);
    }
    if (workloads === 0) {
      throw new FilesInputError(`${dir} has no Deployment, StatefulSet or DaemonSet to mount files into`);
    }
    if (files.size === 0) return null;
    const what = input.mounts.length === 0 ? "no files" : input.mounts.map((m) => m.key).join(", ");
    return { files, message: `chore(${input.project}/${input.component.name}): mount ${what}\n\nBy ${input.by}.` };
  });
  if (result.status === "error") {
    if (result.kind === "stale_head" || result.kind === "ref_race") {
      throw new FilesConflict("the deploy repository kept changing; try again");
    }
    throw new Error(`committing the files failed: ${result.message}`);
  }
  return { status: result.status, commit: result.status === "committed" ? result.sha : null };
}
