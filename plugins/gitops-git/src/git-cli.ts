/**
 * RepoIO over the git command line, so any Git host works (GitHub, Gitea,
 * a bare repository on disk).
 *
 * Commits are built with plumbing directly on top of `expectedHead` — no
 * working tree, no checkout — and pushed with
 * `--force-with-lease=<branch>:<expectedHead>`. If another writer moved the
 * branch in between, the host rejects the push and the result is `stale_head`.
 * That lease is the compare-and-swap.
 *
 * Credentials are passed as an HTTP header through git's environment-based
 * configuration, never in a URL or on a command line.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitResult, PendingCommit, RepoFile, RepoIO } from "./repo.ts";

export interface GitCliOptions {
  /** Repository URL: https://… or a local path / file:// URL. */
  url: string;
  branch: string;
  /**
   * Sent as `Authorization: Basic base64(username:token)` when set. A function
   * is asked before each git command, for tokens that expire (a GitHub App's).
   */
  token?: string | (() => Promise<string>);
  username?: string;
  author?: { name: string; email: string };
}

const NETWORK = new Set(["fetch", "ls-remote", "push"]);

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitCliRepo implements RepoIO {
  private dir: string | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly options: GitCliOptions;

  constructor(options: GitCliOptions) {
    this.options = options;
    const author = options.author ?? { name: "stardust", email: "stardust@localhost" };
    this.env = {
      PATH: process.env.PATH,
      HOME: tmpdir(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    };
  }

  /** The credential header as git configuration, with the token as it is now. */
  private async auth(): Promise<NodeJS.ProcessEnv> {
    const { token } = this.options;
    const value = typeof token === "function" ? await token() : token;
    if (!value) return {};
    const basic = Buffer.from(`${this.options.username ?? "x-access-token"}:${value}`).toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
  }

  private async git(args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
    // Only commands that talk to the host get the credential; local ones never see it.
    const auth = NETWORK.has(args[0] ?? "") ? await this.auth() : {};
    return new Promise((resolve) => {
      const child = execFile(
        "git",
        args,
        { cwd: this.dir ?? undefined, env: { ...this.env, ...auth, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: unknown }).code as number) || 1 : 0;
          resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  private async ok(args: string[], input?: string, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
    const run = await this.git(args, input, extraEnv);
    if (run.code !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`);
    return run.stdout;
  }

  private async repo(): Promise<void> {
    if (this.dir) return;
    this.dir = await mkdtemp(join(tmpdir(), "stardust-gitops-"));
    // Not bare: update-index needs a work tree, though none is ever checked out.
    await this.ok(["init", "-q"]);
  }

  /** Makes sure `ref` (a commit SHA) is available locally. */
  private async have(ref: string): Promise<void> {
    await this.repo();
    if ((await this.git(["cat-file", "-e", `${ref}^{commit}`])).code === 0) return;
    await this.ok([
      "fetch",
      "-q",
      this.options.url,
      `+refs/heads/${this.options.branch}:refs/remotes/origin/${this.options.branch}`,
    ]);
    if ((await this.git(["cat-file", "-e", `${ref}^{commit}`])).code !== 0) {
      throw new Error(`commit ${ref} is not on ${this.options.branch}`);
    }
  }

  async headSha(): Promise<string> {
    await this.repo();
    const out = await this.ok(["ls-remote", this.options.url, `refs/heads/${this.options.branch}`]);
    const sha = out.split(/\s/)[0];
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`branch ${this.options.branch} not found`);
    return sha;
  }

  async readFile(path: string, ref: string): Promise<RepoFile | null> {
    await this.have(ref);
    const sha = await this.git(["rev-parse", "--verify", "-q", `${ref}:${path}`]);
    if (sha.code !== 0) return null;
    const content = await this.ok(["cat-file", "blob", sha.stdout.trim()]);
    return { content, sha: sha.stdout.trim() };
  }

  async listDir(path: string, ref: string): Promise<string[]> {
    await this.have(ref);
    const out = await this.git(["ls-tree", "--name-only", ref, `${path.replace(/\/$/, "")}/`]);
    if (out.code !== 0) return [];
    return out.stdout
      .split("\n")
      .filter(Boolean)
      .map((p) => p.slice(path.replace(/\/$/, "").length + 1))
      .sort();
  }

  async commit(files: PendingCommit, message: string, expectedHead: string): Promise<CommitResult> {
    try {
      await this.have(expectedHead);
      const index = join(this.dir as string, `index-${process.pid}-${Date.now()}`);
      const env = { GIT_INDEX_FILE: index };
      await this.ok(["read-tree", expectedHead], undefined, env);
      for (const [path, content] of files) {
        if (content === null) {
          await this.ok(["update-index", "--force-remove", "--", path], undefined, env);
        } else {
          const blob = (await this.ok(["hash-object", "-w", "--stdin"], content)).trim();
          await this.ok(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, env);
        }
      }
      const tree = (await this.ok(["write-tree"], undefined, env)).trim();
      await rm(index, { force: true });
      const parentTree = (await this.ok(["rev-parse", `${expectedHead}^{tree}`])).trim();
      if (tree === parentTree) return { status: "no_change" };
      const sha = (await this.ok(["commit-tree", tree, "-p", expectedHead, "-m", message])).trim();
      const push = await this.git([
        "push",
        "-q",
        "--porcelain",
        `--force-with-lease=refs/heads/${this.options.branch}:${expectedHead}`,
        this.options.url,
        `${sha}:refs/heads/${this.options.branch}`,
      ]);
      if (push.code === 0) return { status: "committed", sha };
      const text = `${push.stdout}\n${push.stderr}`;
      if (/stale info|fetch first|non-fast-forward|\[rejected\]/.test(text)) {
        return { status: "error", kind: "stale_head", message: `${this.options.branch} moved from ${expectedHead}` };
      }
      return { status: "error", kind: "other", message: `push failed: ${push.stderr.trim()}` };
    } catch (err) {
      return { status: "error", kind: "other", message: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = null;
  }
}
