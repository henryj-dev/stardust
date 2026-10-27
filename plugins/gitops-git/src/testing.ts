/**
 * An in-memory deploy repository with the same compare-and-swap rule as a
 * real Git host: a commit lands only on top of the expected head.
 */
import type { CommitResult, PendingCommit, RepoFile, RepoIO } from "./repo.ts";

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
    return content === undefined ? null : { content, sha: `${ref}:${path}` };
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
