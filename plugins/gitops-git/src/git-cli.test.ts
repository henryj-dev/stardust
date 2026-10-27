/**
 * GitCliRepo against real git: a bare "remote" on disk and a second clone that
 * plays the other writer. The compare-and-swap comes from the host rejecting a
 * lease that no longer holds, so a competing push must turn into stale_head
 * and a re-planned commit must keep the competitor's change.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bumpImage } from "./bump.ts";
import { GitCliRepo } from "./git-cli.ts";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  })
    .toString()
    .trim();

let root: string;
let remote: string;
let other: string;
const DIR = "deploy/demo/api";
const manifest = (tag: string) => `image: registry.example.com/demo/api:${tag}\n`;
const SHA = "1234567890abcdef1234567890abcdef12345678";
const noSleep = { sleep: async () => {} };

before(() => {
  root = mkdtempSync(join(tmpdir(), "gitcli-test-"));
  remote = join(root, "remote.git");
  other = join(root, "other");
  sh(root, "init", "-q", "--bare", "-b", "main", remote);
  sh(root, "clone", "-q", remote, other);
  sh(other, "checkout", "-q", "-b", "main");
  execFileSync("mkdir", ["-p", join(other, DIR)]);
  writeFileSync(join(other, DIR, "deployment.yaml"), manifest("old"));
  writeFileSync(join(other, DIR, "kustomization.yaml"), "resources:\n  - deployment.yaml\n");
  writeFileSync(join(other, "README.md"), "deploy repo\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-q", "-m", "seed");
  sh(other, "push", "-q", "origin", "main");
});
after(() => rmSync(root, { recursive: true, force: true }));

const remoteFile = (path: string) => sh(other, "show", `origin/main:${path}`);
const fetchOther = () => sh(other, "fetch", "-q", "origin");

describe("GitCliRepo", () => {
  it("reads the head, files and directories at a commit", async () => {
    const repo = new GitCliRepo({ url: remote, branch: "main" });
    const head = await repo.headSha();
    assert.equal(head, sh(other, "rev-parse", "HEAD"));
    assert.equal((await repo.readFile(`${DIR}/deployment.yaml`, head))?.content, manifest("old"));
    assert.equal(await repo.readFile(`${DIR}/missing.yaml`, head), null);
    assert.deepEqual(await repo.listDir(DIR, head), ["deployment.yaml", "kustomization.yaml"]);
    await repo.close();
  });

  it("commits exactly the given changes on top of the expected head", async () => {
    const repo = new GitCliRepo({ url: remote, branch: "main" });
    const head = await repo.headSha();
    const result = await repo.commit(
      new Map([
        [`${DIR}/deployment.yaml`, manifest("new")],
        ["README.md", null],
      ]),
      "test: change",
      head,
    );
    assert.equal(result.status, "committed");
    fetchOther();
    assert.equal(sh(other, "rev-parse", "origin/main^"), head, "parent is the expected head");
    assert.equal(remoteFile(`${DIR}/deployment.yaml`), manifest("new").trim());
    assert.throws(() => remoteFile("README.md"), "the file was deleted");
    assert.equal(remoteFile(`${DIR}/kustomization.yaml`), "resources:\n  - deployment.yaml", "untouched file kept");
    await repo.close();
  });

  it("an identical tree is no_change, not an empty commit", async () => {
    const repo = new GitCliRepo({ url: remote, branch: "main" });
    const head = await repo.headSha();
    assert.deepEqual(await repo.commit(new Map([[`${DIR}/deployment.yaml`, manifest("new")]]), "noop", head), {
      status: "no_change",
    });
    await repo.close();
  });

  it("a push after the branch moved is stale_head and writes nothing", async () => {
    const repo = new GitCliRepo({ url: remote, branch: "main" });
    const head = await repo.headSha();
    writeFileSync(join(other, "other.txt"), "x\n");
    fetchOther();
    sh(other, "reset", "-q", "--hard", "origin/main");
    writeFileSync(join(other, "other.txt"), "competitor\n");
    sh(other, "add", "-A");
    sh(other, "commit", "-q", "-m", "competitor");
    sh(other, "push", "-q", "origin", "main");
    const competitor = sh(other, "rev-parse", "HEAD");
    const result = await repo.commit(new Map([["mine.txt", "mine\n"]]), "mine", head);
    assert.equal(result.status, "error");
    assert.ok(result.status === "error" && result.kind === "stale_head", JSON.stringify(result));
    fetchOther();
    assert.equal(sh(other, "rev-parse", "origin/main"), competitor, "the competitor's commit is still the tip");
    await repo.close();
  });

  it("bumpImage over real git re-plans after a competing push and keeps it", async () => {
    const repo = new GitCliRepo({ url: remote, branch: "main" });
    const realCommit = repo.commit.bind(repo);
    let competed = false;
    repo.commit = async (files, message, expectedHead) => {
      if (!competed) {
        competed = true;
        fetchOther();
        sh(other, "reset", "-q", "--hard", "origin/main");
        writeFileSync(join(other, DIR, "config.yaml"), "kind: ConfigMap\n");
        writeFileSync(join(other, DIR, "kustomization.yaml"), "resources:\n  - deployment.yaml\n  - config.yaml\n");
        sh(other, "add", "-A");
        sh(other, "commit", "-q", "-m", "add config");
        sh(other, "push", "-q", "origin", "main");
      }
      return realCommit(files, message, expectedHead);
    };
    const result = await bumpImage(repo, { dir: DIR, project: "demo", component: "api", sha: SHA }, noSleep);
    assert.equal(result.status, "committed", JSON.stringify(result));
    fetchOther();
    assert.equal(remoteFile(`${DIR}/deployment.yaml`), manifest("1234567").trim());
    assert.equal(remoteFile(`${DIR}/config.yaml`), "kind: ConfigMap");
    assert.equal(sh(other, "log", "-1", "--format=%s", "origin/main"), "chore(demo/api): image -> 1234567");
    await repo.close();
  });
});
