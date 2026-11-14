/** The RepoIO contract against real git: a bare remote on disk, and a second clone as the other writer. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoContract } from "@stardust/core/testing";
import { GitCliRepo } from "./git-cli.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });

const write = (root: string, changes: Record<string, string | null>) => {
  for (const [path, content] of Object.entries(changes)) {
    const file = join(root, path);
    if (content === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
};

repoContract("GitCliRepo", async (seed) => {
  const root = mkdtempSync(join(tmpdir(), "repo-contract-"));
  const remote = join(root, "remote.git");
  const other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, other);
  git(other, "checkout", "-q", "-b", "main");
  write(other, seed);
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "seed");
  git(other, "push", "-q", "origin", "main");
  return {
    repo: new GitCliRepo({ url: remote, branch: "main" }),
    async pushOther(changes) {
      git(other, "pull", "-q", "--ff-only", "origin", "main");
      write(other, changes);
      git(other, "add", "-A");
      git(other, "commit", "-q", "-m", "other writer");
      git(other, "push", "-q", "origin", "main");
    },
    async cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
});
