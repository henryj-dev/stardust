import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bumpImage, bumpMessage } from "./bump.ts";
import { commitWithCas } from "./cas.ts";
import { addResource } from "./kustomization.ts";
import type { CommitResult, RepoIO } from "./repo.ts";
import { MemoryRepo } from "./testing.ts";

const noSleep = { sleep: async () => {} };

/** A repo whose commit results are scripted, for the protocol cases. */
function scripted(heads: string[], results: CommitResult[]) {
  const log: string[] = [];
  let h = 0;
  let r = 0;
  const io: RepoIO = {
    async headSha() {
      const v = heads[Math.min(h++, heads.length - 1)] as string;
      log.push(`head:${v}`);
      return v;
    },
    async readFile(path, ref) {
      log.push(`read:${path}@${ref}`);
      return { content: `content@${ref}`, sha: "b" };
    },
    async listDir() {
      return [];
    },
    async commit(files, _message, expectedHead) {
      log.push(`commit:${[...files.keys()].join(",")}@${expectedHead}`);
      return results[Math.min(r++, results.length - 1)] as CommitResult;
    },
  };
  return { io, log };
}
const stale: CommitResult = { status: "error", kind: "stale_head", message: "moved" };

describe("commitWithCas", () => {
  it("after a stale head it re-plans at the new head and commits against it", async () => {
    const { io, log } = scripted(["h1", "h2"], [stale, { status: "committed", sha: "c" }]);
    const result = await commitWithCas(
      io,
      async (_head, at) => {
        const f = await at.read("a.yaml");
        return { files: new Map([["a.yaml", `${f?.content}!`]]), message: "m" };
      },
      noSleep,
    );
    assert.deepEqual(result, { status: "committed", sha: "c" });
    assert.deepEqual(log, [
      "head:h1",
      "read:a.yaml@h1",
      "commit:a.yaml@h1",
      "head:h2",
      "read:a.yaml@h2",
      "commit:a.yaml@h2",
    ]);
  });
  it("retries a ref race too", async () => {
    const race: CommitResult = { status: "error", kind: "ref_race", message: "race" };
    const { io } = scripted(["h1", "h2"], [race, { status: "committed", sha: "c" }]);
    assert.equal(
      (await commitWithCas(io, async () => ({ files: new Map([["a", "x"]]), message: "m" }), noSleep)).status,
      "committed",
    );
  });
  it("returns a non-retryable error at once: one plan, one commit", async () => {
    const other: CommitResult = { status: "error", kind: "other", message: "403" };
    const { io, log } = scripted(["h1"], [other]);
    assert.deepEqual(
      await commitWithCas(io, async () => ({ files: new Map([["a", "x"]]), message: "m" }), noSleep),
      other,
    );
    assert.equal(log.filter((l) => l.startsWith("commit:")).length, 1);
  });
  it("returns the last stale result when every attempt hits a moving head (4 by default)", async () => {
    const { io, log } = scripted(["h1", "h2", "h3", "h4", "h5"], [stale]);
    assert.deepEqual(
      await commitWithCas(io, async () => ({ files: new Map([["a", "x"]]), message: "m" }), noSleep),
      stale,
    );
    assert.equal(log.filter((l) => l.startsWith("commit:")).length, 4);
  });
  it("does not commit when there is nothing to do", async () => {
    const { io, log } = scripted(["h1"], [stale]);
    assert.deepEqual(await commitWithCas(io, async () => null, noSleep), { status: "no_change" });
    assert.deepEqual(await commitWithCas(io, async () => ({ files: new Map(), message: "m" }), noSleep), {
      status: "no_change",
    });
    assert.ok(!log.some((l) => l.startsWith("commit:")));
  });
  it("propagates an error thrown while planning", async () => {
    const { io } = scripted(["h1"], [stale]);
    await assert.rejects(
      commitWithCas(
        io,
        async () => {
          throw new Error("no kustomization");
        },
        noSleep,
      ),
      /no kustomization/,
    );
  });
  it("backs off longer each time and does not wait after the last attempt", async () => {
    const waits: number[] = [];
    const { io } = scripted(["h1", "h2", "h3"], [stale]);
    await commitWithCas(io, async () => ({ files: new Map([["a", "x"]]), message: "m" }), {
      attempts: 3,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.deepEqual(waits, [250, 500]);
  });
});

describe("bumpImage against a repository that enforces compare-and-swap", () => {
  const DIR = "deploy/demo/api";
  const manifest = (tag: string) => `image: registry.example.com/demo/api:${tag}\n`;
  const SHA = "1234567890abcdef1234567890abcdef12345678";

  it("bumps every manifest using the image in one commit with the self-commit message", async () => {
    const repo = new MemoryRepo({
      [`${DIR}/deployment.yaml`]: manifest("old"),
      [`${DIR}/worker.yaml`]: manifest("old"),
      [`${DIR}/kustomization.yaml`]: "resources:\n  - deployment.yaml\n  - worker.yaml\n",
    });
    const result = await bumpImage(repo, { dir: DIR, project: "demo", component: "api", sha: SHA }, noSleep);
    assert.equal(result.status, "committed");
    assert.equal(repo.commitCount(), 1);
    assert.equal(repo.files()[`${DIR}/worker.yaml`], manifest("1234567"));
    assert.equal(repo.log.at(-1), `commit:${bumpMessage("demo", "api", "1234567")}`);
  });

  it("the message matches what the GitHub source treats as a self-commit", () => {
    // Same pattern as plugins/source-github SELF_COMMIT_RE; plugins may not import each other.
    assert.match(bumpMessage("demo", "api", "1234567"), /^chore\([^/]+\/[^)]+\): (image|env) -> /);
  });

  it("a competing commit during planning is not overwritten: the bump re-plans on top of it", async () => {
    const repo = new MemoryRepo({
      [`${DIR}/deployment.yaml`]: manifest("old"),
      [`${DIR}/kustomization.yaml`]: "resources:\n  - deployment.yaml\n",
    });
    let competed = false;
    repo.beforeCommit = () => {
      if (competed) return;
      competed = true;
      // Another writer adds a file and its list entry in the same commit.
      repo.push({
        [`${DIR}/config.yaml`]: "kind: ConfigMap\n",
        [`${DIR}/kustomization.yaml`]: addResource("resources:\n  - deployment.yaml\n", "config.yaml"),
      });
    };
    const result = await bumpImage(repo, { dir: DIR, project: "demo", component: "api", sha: SHA }, noSleep);
    assert.equal(result.status, "committed");
    const files = repo.files();
    assert.equal(files[`${DIR}/deployment.yaml`], manifest("1234567"));
    assert.equal(files[`${DIR}/config.yaml`], "kind: ConfigMap\n", "the competing commit survived");
    assert.match(files[`${DIR}/kustomization.yaml`] ?? "", /config\.yaml/);
    assert.ok(
      repo.log.some((l) => l.startsWith("stale:")),
      "the first attempt must have been stale",
    );
  });

  it("already up to date is no_change; no reference is an error, not a silent zero", async () => {
    const repo = new MemoryRepo({ [`${DIR}/deployment.yaml`]: manifest("1234567") });
    assert.deepEqual(await bumpImage(repo, { dir: DIR, project: "demo", component: "api", sha: SHA }, noSleep), {
      status: "no_change",
    });
    const wrong = await bumpImage(repo, { dir: DIR, project: "demo", component: "web", sha: SHA }, noSleep);
    assert.equal(wrong.status, "error");
    assert.ok(wrong.status === "error" && wrong.kind === "no_reference");
    assert.equal(repo.commitCount(), 0);
  });
});
