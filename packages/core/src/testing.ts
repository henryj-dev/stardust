/**
 * An in-memory deploy repository with the same compare-and-swap rule as a
 * real Git host: a commit lands only on top of the expected head.
 */
import { createHash } from "node:crypto";
import type { CommitResult, PendingCommit, RepoFile, RepoIO } from "./ports/repo.ts";

export { computeProviderContract } from "./ports/testing/compute.contract.ts";
export { databaseProviderContract } from "./ports/testing/databases.contract.ts";
export { dnsProviderContract } from "./ports/testing/dns.contract.ts";
export type { LogSeed } from "./ports/testing/logs.contract.ts";
export { logSourceContract } from "./ports/testing/logs.contract.ts";
export { objectStoreContract } from "./ports/testing/store.contract.ts";

import {
  type ComputeCatalog,
  type ComputeInstance,
  type ComputeProvider,
  type CreateInstanceInput,
  createInstanceProblems,
} from "./ports/compute.ts";
import { type DnsProvider, type DnsRecord, dnsRecordProblems, normalizeDnsName } from "./ports/dns.ts";
import type { ObjectStore } from "./ports/store.ts";

/** DNS in memory, with views when given some; it keeps the same contract as the real adapters. */
export class MemoryDns implements DnsProvider {
  readonly capabilities: DnsProvider["capabilities"];
  readonly zones: string[];
  readonly records: Array<DnsRecord & { zone: string }> = [];
  private next = 1;
  constructor(zones: string[], views: string[] = []) {
    this.zones = zones;
    this.capabilities = { views, proxied: false, asyncApply: false };
  }
  async listZones(): Promise<string[]> {
    return [...this.zones].sort();
  }
  async listRecords(zone: string, filter: { name?: string; type?: string; view?: string } = {}): Promise<DnsRecord[]> {
    return this.records
      .filter((r) => r.zone === normalizeDnsName(zone))
      .filter(
        (r) => (!filter.name || r.name === normalizeDnsName(filter.name)) && (!filter.type || r.type === filter.type),
      )
      .filter((r) => !filter.view || r.view === filter.view)
      .map(({ zone: _z, ...r }) => ({ ...r }));
  }
  async upsert(zone: string, input: Parameters<DnsProvider["upsert"]>[1]): Promise<DnsRecord> {
    const problems = dnsRecordProblems(zone, input);
    if (problems.length > 0) throw new Error(problems.join("; "));
    const name = normalizeDnsName(input.name);
    const view = input.view ?? null;
    const existing = this.records.find(
      (r) => r.zone === normalizeDnsName(zone) && r.name === name && r.type === input.type && r.view === view,
    );
    const record = {
      id: existing?.id ?? `m${this.next++}`,
      name,
      type: input.type,
      content: input.content,
      ttl: input.ttl,
      view,
    };
    if (existing) Object.assign(existing, record);
    else this.records.push({ ...record, zone: normalizeDnsName(zone) });
    return { ...record };
  }
  async delete(zone: string, id: string): Promise<void> {
    const i = this.records.findIndex((r) => r.zone === normalizeDnsName(zone) && r.id === id);
    if (i >= 0) this.records.splice(i, 1);
  }
}

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
    // As Git lists a tree: the files and the directories directly inside; "" is the root.
    const dir = path.replace(/\/$/, "");
    const prefix = dir ? `${dir}/` : "";
    const names = new Set<string>();
    for (const p of this.at(ref).files.keys()) {
      if (!p.startsWith(prefix)) continue;
      names.add(p.slice(prefix.length).split("/")[0] as string);
    }
    return [...names].sort();
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

/** Instances in memory, with a small fixed catalog; it keeps the compute contract. */
export class MemoryCompute implements ComputeProvider {
  readonly capabilities = { resize: true, reverseDns: true, console: false };
  readonly instances = new Map<string, ComputeInstance & { userData: string | null }>();
  readonly reverse = new Map<string, string>();
  private next = 1;
  async catalog(): Promise<ComputeCatalog> {
    return {
      regions: [{ id: "ams", city: "Amsterdam", country: "NL" }],
      plans: [
        { id: "small", vcpus: 1, memoryMb: 1024, diskGb: 25, monthlyCost: 5, regions: ["ams"] },
        { id: "large", vcpus: 4, memoryMb: 8192, diskGb: 160, monthlyCost: 40, regions: ["ams"] },
      ],
      images: [{ id: "rocky-10", name: "Rocky Linux 10" }],
      sshKeys: [{ id: "k1", name: "ops" }],
      networks: [{ id: "n1", name: "private", region: "ams", subnet: "10.10.0.0/20" }],
    };
  }
  async list(): Promise<ComputeInstance[]> {
    return [...this.instances.values()].map(({ userData: _u, ...i }) => ({ ...i }));
  }
  async get(id: string): Promise<ComputeInstance | null> {
    const found = this.instances.get(id);
    if (!found) return null;
    const { userData: _u, ...i } = found;
    return { ...i };
  }
  async create(input: CreateInstanceInput): Promise<ComputeInstance> {
    const problems = createInstanceProblems(input);
    if (problems.length > 0) throw new Error(problems.join("; "));
    const id = `00000000-0000-4000-8000-${String(this.next++).padStart(12, "0")}`;
    const made = {
      id,
      label: input.label,
      hostname: input.hostname,
      region: input.region,
      plan: input.plan,
      os: "Rocky Linux 10",
      state: "pending" as const,
      mainIp: `192.0.2.${this.next}`,
      ipv6: null,
      internalIp: input.networks?.length ? `10.10.0.${this.next}` : null,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
      userData: input.userData ?? null,
    };
    this.instances.set(id, made);
    const { userData: _u, ...i } = made;
    return { ...i };
  }
  async resize(id: string, plan: string): Promise<void> {
    const i = this.instances.get(id);
    if (!i) throw new Error("no such instance");
    i.plan = plan;
  }
  async clearUserData(id: string, note: string): Promise<void> {
    const i = this.instances.get(id);
    if (!i) throw new Error("no such instance");
    i.userData = `# cleared: ${note}`;
  }
  async setReverseDns(_id: string, ip: string, name: string): Promise<void> {
    this.reverse.set(ip, name);
  }
  async destroy(id: string, approval: string): Promise<void> {
    if (!approval) throw new Error("deleting needs an approval");
    this.instances.delete(id);
  }
}
