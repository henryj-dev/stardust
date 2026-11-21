/**
 * A deploy repository on disk for tests: a bare "remote" the server writes
 * to through GitCliRepo, and a clone that plays the person editing by hand.
 * The in-memory repository answers some reads differently from Git (it does
 * not list directories, for one), so paths that commit run against this too.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();

export interface GitFixture {
  /** The bare repository, as a URL for GitCliRepo. */
  remote: string;
  /** The tip of main on the remote. */
  head(): string;
  /** A file on the remote's main, or null. */
  read(path: string): string | null;
  /** Commits and pushes these files (null deletes) as the person editing by hand. */
  push(files: Record<string, string | null>, message?: string): void;
  cleanup(): void;
}

export function gitFixture(seed: Record<string, string>): GitFixture {
  const tmp = mkdtempSync(join(tmpdir(), "deploy-git-"));
  const remote = join(tmp, "remote.git");
  const hand = join(tmp, "hand");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "clone", "-q", remote, hand);
  git(hand, "checkout", "-q", "-b", "main");
  const write = (files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      const file = join(hand, path);
      if (content === null) rmSync(file, { force: true });
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
    }
  };
  write(seed);
  git(hand, "add", "-A");
  git(hand, "commit", "-q", "-m", "seed");
  git(hand, "push", "-q", "origin", "main");
  return {
    remote,
    head: () => git(hand, "ls-remote", remote, "refs/heads/main").split(/\s/)[0] ?? "",
    read(path) {
      git(hand, "fetch", "-q", "origin");
      try {
        return git(hand, "show", `origin/main:${path}`);
      } catch {
        return null;
      }
    },
    push(files, message = "by hand") {
      git(hand, "pull", "-q", "--ff-only", "origin", "main");
      write(files);
      git(hand, "add", "-A");
      git(hand, "commit", "-q", "-m", message);
      git(hand, "push", "-q", "origin", "main");
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
