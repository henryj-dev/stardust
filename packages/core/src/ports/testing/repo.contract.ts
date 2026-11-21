/**
 * The contract every RepoIO implementation must keep. The in-memory fake and
 * each real implementation run this same suite, so a test that passes against
 * the fake says something about the real thing.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { RepoIO } from "../repo.ts";

export interface RepoFixture {
  repo: RepoIO;
  /** Commits on the branch as another writer would, behind `repo`'s back. */
  pushOther(changes: Record<string, string | null>): Promise<void>;
  cleanup?(): Promise<void>;
}

const SEED = {
  "deploy/demo/api/deployment.yaml": "image: registry.example.com/demo/api:old\n",
  "deploy/demo/api/kustomization.yaml": "resources:\n  - deployment.yaml\n",
  "deploy/demo/web/deployment.yaml": "image: registry.example.com/demo/web:old\n",
  "README.md": "deploy repository\n",
};

export function repoContract(name: string, setup: (seed: Record<string, string>) => Promise<RepoFixture>): void {
  describe(`RepoIO contract: ${name}`, () => {
    let f: RepoFixture;
    before(async () => {
      f = await setup(SEED);
    });
    after(async () => f.cleanup?.());

    it("reads files at the head; a missing one is null", async () => {
      const head = await f.repo.headSha();
      assert.equal(typeof head, "string");
      const file = await f.repo.readFile("README.md", head);
      assert.equal(file?.content, "deploy repository\n");
      assert.equal(await f.repo.readFile("nope.yaml", head), null);
    });

    it("lists only the files directly inside a directory, sorted", async () => {
      const head = await f.repo.headSha();
      assert.deepEqual(await f.repo.listDir("deploy/demo/api", head), ["deployment.yaml", "kustomization.yaml"]);
      assert.deepEqual(await f.repo.listDir("deploy/demo/api/", head), ["deployment.yaml", "kustomization.yaml"]);
    });

    it("lists the directories inside a directory by name, and the root as an empty path", async () => {
      const head = await f.repo.headSha();
      assert.deepEqual(await f.repo.listDir("deploy/demo", head), ["api", "web"]);
      const root = await f.repo.listDir("", head);
      assert.ok(root.includes("deploy") && root.includes("README.md"), root.join());
      assert.equal(await f.repo.readFile("deploy/demo", head), null, "a directory is not a file");
    });

    it("commits on top of the expected head; the old commit still reads as it was", async () => {
      const before = await f.repo.headSha();
      const result = await f.repo.commit(
        new Map<string, string | null>([
          ["deploy/demo/api/deployment.yaml", "image: registry.example.com/demo/api:new\n"],
          ["deploy/demo/web/deployment.yaml", null],
        ]),
        "contract: change two files",
        before,
      );
      assert.equal(result.status, "committed");
      const after = await f.repo.headSha();
      assert.equal(result.status === "committed" && result.sha, after);
      assert.notEqual(after, before);
      assert.equal(
        (await f.repo.readFile("deploy/demo/api/deployment.yaml", after))?.content,
        "image: registry.example.com/demo/api:new\n",
      );
      assert.equal(await f.repo.readFile("deploy/demo/web/deployment.yaml", after), null, "null deletes");
      assert.equal(
        (await f.repo.readFile("deploy/demo/api/deployment.yaml", before))?.content,
        "image: registry.example.com/demo/api:old\n",
      );
    });

    it("refuses a commit whose expected head is stale, and writes nothing", async () => {
      const seen = await f.repo.headSha();
      await f.pushOther({ "deploy/demo/other.yaml": "other writer\n" });
      const result = await f.repo.commit(new Map([["README.md", "lost update\n"]]), "contract: stale", seen);
      assert.equal(result.status, "error");
      assert.equal(result.status === "error" && result.kind, "stale_head");
      const head = await f.repo.headSha();
      assert.equal((await f.repo.readFile("README.md", head))?.content, "deploy repository\n");
      assert.equal((await f.repo.readFile("deploy/demo/other.yaml", head))?.content, "other writer\n");
    });

    it("gives the same file sha for the same content across commits, another for other content", async () => {
      const a = await f.repo.headSha();
      const kept = await f.repo.readFile("deploy/demo/api/kustomization.yaml", a);
      const result = await f.repo.commit(new Map([["README.md", "changed\n"]]), "contract: one file", a);
      assert.equal(result.status, "committed");
      const b = await f.repo.headSha();
      assert.equal((await f.repo.readFile("deploy/demo/api/kustomization.yaml", b))?.sha, kept?.sha);
      assert.notEqual((await f.repo.readFile("README.md", b))?.sha, (await f.repo.readFile("README.md", a))?.sha);
    });
  });
}
