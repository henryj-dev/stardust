/**
 * An in-memory deploy repository with the same compare-and-swap rule as a
 * real Git host: a commit lands only on top of the expected head.
 */
import { createHash } from "node:crypto";
import type { CommitResult, PendingCommit, RepoFile, RepoIO } from "./ports/repo.ts";

export { dnsProviderContract } from "./ports/testing/dns.contract.ts";
export type { LogSeed } from "./ports/testing/logs.contract.ts";
export { logSourceContract } from "./ports/testing/logs.contract.ts";
export { objectStoreContract } from "./ports/testing/store.contract.ts";

import type { ObjectStore } from "./ports/store.ts";

/** Objects in memory, copied in and out. */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), contentType });
  }
  async get(key: string): Promise<Uint8Array | null> {
    const o = this.objects.get(key);
    return o ? new Uint8Array(o.body) : null;
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
export type { RepoFixture } from "./ports/testing/repo.contract.ts";
export { repoContract } from "./ports/testing/repo.contract.ts";
export { guardStoreContract, sagaStoreContract } from "./ports/testing/stores.contract.ts";

import type { GuardStore } from "./guard.ts";
import type { SagaRecord, SagaStore } from "./saga.ts";

/** Saga records in memory, copied in and out like a database would. */
export class MemorySagaStore implements SagaStore {
  readonly records = new Map<string, SagaRecord>();
  saves = 0;
  async create(record: SagaRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`saga ${record.id} exists`);
    this.records.set(record.id, structuredClone(record));
  }
  async load(id: string): Promise<SagaRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }
  async save(record: SagaRecord): Promise<void> {
    this.saves++;
    this.records.set(record.id, structuredClone(record));
  }
}

export class MemoryGuardStore implements GuardStore {
  private used = new Set<string>();
  private events = new Map<string, number[]>();
  now = () => Date.now();
  async useOnce(scope: string, id: string): Promise<boolean> {
    const key = `${scope}\0${id}`;
    if (this.used.has(key)) return false;
    this.used.add(key);
    return true;
  }
  async count(scope: string, key: string, windowMs: number): Promise<number> {
    const name = `${scope}\0${key}`;
    const since = this.now() - windowMs;
    const kept = (this.events.get(name) ?? []).filter((t) => t > since);
    kept.push(this.now());
    this.events.set(name, kept);
    return kept.length;
  }
}

/** Like a Git blob id: the same content has the same sha in every commit. */
const blobSha = (content: string) => createHash("sha1").update(content).digest("hex");

export class MemoryRepo implements RepoIO {
  private commits: Array<{ sha: string; files: Map<string, string> }> = [];
  /** Called before every commit attempt; tests use it to slip in a competing commit. */
  beforeCommit: (() => void) | null = null;
  readonly log: string[] = [];

  constructor(files: Record<string, string> = {}) {
    this.commits.push({ sha: "c0", files: new Map(Object.entries(files)) });
  }

  private tip() {
    return this.commits[this.commits.length - 1] as { sha: string; files: Map<string, string> };
  }

  private at(ref: string) {
    const commit = this.commits.find((c) => c.sha === ref);
    if (!commit) throw new Error(`unknown ref ${ref}`);
    return commit;
  }

  files(): Record<string, string> {
    return Object.fromEntries(this.tip().files);
  }

  commitCount(): number {
    return this.commits.length - 1;
  }

  /** Writes directly, as another writer would. */
  push(changes: Record<string, string | null>, message = "external"): void {
    const files = new Map(this.tip().files);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    this.commits.push({ sha: `c${this.commits.length}`, files });
    this.log.push(`push:${message}`);
  }

  async headSha(): Promise<string> {
    return this.tip().sha;
  }

  async readFile(path: string, ref: string): Promise<RepoFile | null> {
    const content = this.at(ref).files.get(path);
    return content === undefined ? null : { content, sha: blobSha(content) };
  }

  async listDir(path: string, ref: string): Promise<string[]> {
    const prefix = `${path.replace(/\/$/, "")}/`;
    return [...this.at(ref).files.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map((p) => p.slice(prefix.length))
      .sort();
  }

  async commit(changes: PendingCommit, message: string, expectedHead: string): Promise<CommitResult> {
    this.beforeCommit?.();
    if (this.tip().sha !== expectedHead) {
      this.log.push(`stale:${expectedHead}`);
      return { status: "error", kind: "stale_head", message: `head moved from ${expectedHead}` };
    }
    const files = new Map(this.tip().files);
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    const sha = `c${this.commits.length}`;
    this.commits.push({ sha, files });
    this.log.push(`commit:${message}`);
    return { status: "committed", sha };
  }
}
