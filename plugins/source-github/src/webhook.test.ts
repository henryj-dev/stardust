/**
 * The predecessor's webhook cases, carried over: signature, policy table,
 * changed paths and fork pull requests. Reasons are reworded in English; the
 * decisions are the same.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { shouldSkipForPaths } from "@stardust/core";
import { decideWebhook } from "./decide.ts";
import { judgeForkPullRequest } from "./fork.ts";
import { COMPARE_FILES_LIMIT, type CompareResult, resolveChangedPaths } from "./paths.ts";
import {
  isProjectDisabled,
  judgePush,
  POLICY,
  REASON_SELF_COMMIT,
  REASON_SKIP_CI,
  SELF_COMMIT_RE,
  SKIP_CI_RE,
} from "./policy.ts";
import { verifySignature } from "./signature.ts";

describe("verifySignature", () => {
  const SECRET = "s3cr3t";
  const BODY = '{"zen":"Non-blocking is better than blocking."}';
  const good = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;

  it("accepts the right signature, also in upper-case hex", () => {
    assert.equal(verifySignature(BODY, good, SECRET), true);
    assert.equal(verifySignature(BODY, good.toUpperCase().replace("SHA256=", "sha256="), SECRET), true);
  });
  it("rejects a wrong secret, body, prefix or missing header", () => {
    assert.equal(verifySignature(BODY, good, "wrong"), false);
    assert.equal(verifySignature(`${BODY} `, good, SECRET), false);
    assert.equal(verifySignature(BODY, good.replace("sha256=", "sha1="), SECRET), false);
    assert.equal(verifySignature(BODY, undefined, SECRET), false);
  });
  it("rejects, without throwing, non-hex values of the right length", () => {
    for (const bad of ["z".repeat(64), "!".repeat(64), `${"0".repeat(63)}g`, " ".repeat(64)]) {
      assert.doesNotThrow(() => verifySignature(BODY, `sha256=${bad}`, SECRET));
      assert.equal(verifySignature(BODY, `sha256=${bad}`, SECRET), false);
    }
  });
  it("rejects, without throwing, hex of the wrong length", () => {
    for (const bad of ["", "ab", "a".repeat(63), "a".repeat(65), "a".repeat(128)]) {
      assert.doesNotThrow(() => verifySignature(BODY, `sha256=${bad}`, SECRET));
      assert.equal(verifySignature(BODY, `sha256=${bad}`, SECRET), false);
    }
  });
});

describe("POLICY", () => {
  it("matches the predecessor's exported policy table, except that workspace projects refuse forks", () => {
    // Copied from the predecessor's __fixtures__/webhook-policy.json.
    const predecessor = {
      repo: { skipDisabled: true, skipSelfCommit: true, skipCi: true, judgeForkPr: true },
      workspace: { skipDisabled: true, skipSelfCommit: false, skipCi: true, judgeForkPr: false },
    };
    // The one deliberate difference: a fork's pull request must not build in a workspace project either.
    const expected = { ...predecessor, workspace: { ...predecessor.workspace, judgeForkPr: true } };
    assert.deepEqual(JSON.parse(JSON.stringify(POLICY)), expected);
  });
  it("keeps the predecessor's patterns", () => {
    assert.equal(SELF_COMMIT_RE.source, "^chore\\([^/]+\\/[^)]+\\): (image|env) -> ");
    assert.equal(SKIP_CI_RE.source, "\\[(skip ci|ci skip|no ci|skip ?build)\\]|\\*\\*\\*NO_CI\\*\\*\\*");
    assert.equal(SKIP_CI_RE.flags, "i");
  });
});

describe("judgePush", () => {
  const ALL_ON = { skipDisabled: true, skipSelfCommit: true, skipCi: true, judgeForkPr: true };
  const ALL_OFF = { skipDisabled: false, skipSelfCommit: false, skipCi: false, judgeForkPr: false };

  it("self-commits: image and env", () => {
    assert.equal(judgePush("chore(stardust/dispatcher): image -> abc1234", ALL_ON)?.reason, REASON_SELF_COMMIT);
    assert.equal(judgePush("chore(idp/keystone): env -> abc1234 (configmap)", ALL_ON)?.reason, REASON_SELF_COMMIT);
  });
  it("skip-ci markers, any case", () => {
    for (const msg of [
      "docs: x [skip ci]",
      "x [ci skip]",
      "x [no ci]",
      "x [skipbuild]",
      "x ***NO_CI***",
      "X [SKIP CI]",
    ]) {
      assert.equal(judgePush(msg, ALL_ON)?.reason, REASON_SKIP_CI, msg);
    }
  });
  it("the same messages pass when the policy is off — the table decides", () => {
    assert.equal(judgePush("chore(a/b): image -> abc1234", ALL_OFF), null);
    assert.equal(judgePush("docs: x [skip ci]", ALL_OFF), null);
  });
  it("ordinary messages pass", () => {
    assert.equal(judgePush("feat: something", ALL_ON), null);
    assert.equal(judgePush("", ALL_ON), null);
  });
  it("self-commit is checked first", () => {
    assert.equal(judgePush("chore(a/b): image -> abc [skip ci]", ALL_ON)?.reason, REASON_SELF_COMMIT);
  });
});

describe("isProjectDisabled", () => {
  it("only boolean true disables", () => {
    assert.equal(isProjectDisabled({ disabled: true }), true);
    assert.equal(isProjectDisabled({ disabled: false }), false);
    assert.equal(isProjectDisabled({ disabled: "true" }), false);
    assert.equal(isProjectDisabled({}), false);
    assert.equal(isProjectDisabled(null), false);
  });
});

describe("resolveChangedPaths — the net change between before and after", () => {
  const BEFORE = "a".repeat(40);
  const AFTER = "b".repeat(40);
  // A merge whose commits touch dispatcher/ and dashboard/, while the net change is docs only.
  const payload = (over: Record<string, unknown> = {}) => ({
    before: BEFORE,
    after: AFTER,
    commits: [
      { added: [], modified: ["dispatcher/src/index.ts"], removed: [] },
      { added: ["dashboard/src/x.svelte"], modified: [], removed: [] },
      { added: [], modified: ["docs/a.md"], removed: [] },
    ],
    head_commit: { added: [], modified: ["docs/a.md"], removed: [] },
    ...over,
  });
  const files = (...names: string[]): CompareResult => ({ files: names.map((filename) => ({ filename })) });
  const skipped = (paths: string[]) =>
    shouldSkipForPaths({ pipeline: "C", if: { paths: ["dispatcher/**"] } }, "push", paths);
  const unionPaths = ["dashboard/src/x.svelte", "dispatcher/src/index.ts", "docs/a.md"];

  it("uses compare: a docs-only net change skips a dispatcher/** job", async () => {
    let called: [string, string] | null = null;
    const r = await resolveChangedPaths({
      payload: payload(),
      compare: async (base, head) => {
        called = [base, head];
        return files("docs/a.md");
      },
    });
    assert.deepEqual(called, [BEFORE, AFTER]);
    assert.deepEqual(r, { paths: ["docs/a.md"], source: "compare" });
    assert.equal(skipped(r.paths), true);
  });
  it("control: feeding the union through compare flips that decision", async () => {
    const r = await resolveChangedPaths({ payload: payload(), compare: async () => files(...unionPaths) });
    assert.equal(skipped(r.paths), false);
  });
  it("a rename contributes both names", async () => {
    const r = await resolveChangedPaths({
      payload: payload(),
      compare: async () => ({ files: [{ filename: "docs/moved.md", previous_filename: "dispatcher/old.md" }] }),
    });
    assert.deepEqual(r.paths.sort(), ["dispatcher/old.md", "docs/moved.md"]);
  });
  it("falls back to the union for a new ref without calling compare", async () => {
    let calls = 0;
    const r = await resolveChangedPaths({
      payload: payload({ before: "0".repeat(40) }),
      compare: async () => {
        calls++;
        return files();
      },
    });
    assert.equal(calls, 0);
    assert.equal(r.source, "union");
    assert.match(r.fallback ?? "", /new ref/);
    assert.deepEqual(r.paths.sort(), unionPaths);
  });
  it("falls back to the union for missing or short SHAs, a failing compare, or no files", async () => {
    const short = await resolveChangedPaths({
      payload: payload({ before: undefined, after: "abc" }),
      compare: async () => files(),
    });
    assert.equal(short.source, "union");
    const failing = await resolveChangedPaths({
      payload: payload(),
      compare: async () => {
        throw Object.assign(new Error("limited"), { reason: "rate_limited" });
      },
    });
    assert.equal(failing.fallback, "compare failed (rate_limited)");
    assert.deepEqual(failing.paths.sort(), unionPaths);
    const none = await resolveChangedPaths({ payload: payload(), compare: async () => ({ files: null }) });
    assert.equal(none.source, "union");
  });
  it(`falls back to the union at ${COMPARE_FILES_LIMIT} files, trusts compare just below`, async () => {
    const many = Array.from({ length: COMPARE_FILES_LIMIT }, (_, i) => `docs/f${i}.md`);
    assert.equal(
      (await resolveChangedPaths({ payload: payload(), compare: async () => files(...many) })).source,
      "union",
    );
    assert.equal(
      (await resolveChangedPaths({ payload: payload(), compare: async () => files(...many.slice(1)) })).source,
      "compare",
    );
  });
});

describe("judgeForkPullRequest", () => {
  const pr = (head: string, base: string) => ({
    pull_request: { head: { repo: { full_name: head } }, base: { repo: { full_name: base } } },
  });
  it("same repository passes, also when only the case differs", () => {
    assert.equal(judgeForkPullRequest(pr("acme/app", "acme/app")).fork, false);
    assert.equal(judgeForkPullRequest(pr("ACME/App", "acme/app")).fork, false);
  });
  it("forks and same-owner different repositories are refused", () => {
    const v = judgeForkPullRequest(pr("attacker/app", "acme/app"));
    assert.equal(v.fork, true);
    assert.ok(v.fork && v.reason.includes("attacker/app"));
    assert.equal(judgeForkPullRequest(pr("acme/other", "acme/app")).fork, true);
  });
  it("fails closed: a deleted fork, an unreadable base or a non-string name is refused", () => {
    const deleted = judgeForkPullRequest({
      pull_request: { head: { repo: null }, base: { repo: { full_name: "a/b" } } },
    });
    assert.ok(deleted.fork && deleted.reason.includes("deleted fork"));
    assert.equal(judgeForkPullRequest({ pull_request: { head: { repo: { full_name: "a/b" } } } }).fork, true);
    assert.equal(judgeForkPullRequest({}).fork, true);
    assert.equal(judgeForkPullRequest(null).fork, true);
    assert.equal(
      judgeForkPullRequest({
        pull_request: { head: { repo: { full_name: 123 } }, base: { repo: { full_name: "a/b" } } },
      }).fork,
      true,
    );
  });
});

describe("decideWebhook", () => {
  const push = (over: Record<string, unknown> = {}) => ({
    ref: "refs/heads/main",
    after: "c".repeat(40),
    head_commit: { message: "feat: x" },
    ...over,
  });
  const forkPr = {
    action: "opened",
    pull_request: {
      number: 7,
      head: { sha: "d".repeat(40), repo: { full_name: "attacker/app" } },
      base: { ref: "main", repo: { full_name: "acme/app" } },
    },
  };

  it("a branch push runs with its branch; a tag push runs with its tag", () => {
    assert.deepEqual(decideWebhook("push", push(), POLICY.repo, {}), {
      action: "run",
      event: "push",
      trigger: "push",
      ref: "refs/heads/main",
      sha: "c".repeat(40),
      branch: "main",
    });
    const tag = decideWebhook("push", push({ ref: "refs/tags/v1" }), POLICY.repo, {});
    assert.ok(tag.action === "run" && tag.trigger === "tag" && tag.tag === "v1");
  });
  it("a disabled project and a skip-ci push are ignored", () => {
    assert.equal(decideWebhook("push", push(), POLICY.repo, { metadata: { disabled: true } }).action, "ignore");
    assert.equal(
      decideWebhook("push", push({ head_commit: { message: "x [skip ci]" } }), POLICY.repo, {}).action,
      "ignore",
    );
  });
  it("the fork check runs before a pull request can start a run", () => {
    const d = decideWebhook("pull_request", forkPr, POLICY.repo, {});
    assert.equal(d.action, "ignore");
    assert.ok(d.action === "ignore" && d.reason.startsWith("fork pull request"));
  });
  it("workspace projects refuse a fork's pull request too", () => {
    assert.equal(decideWebhook("pull_request", forkPr, POLICY.workspace, {}).action, "ignore");
  });
  it("control: with the check off the same pull request would run", () => {
    const d = decideWebhook("pull_request", forkPr, { ...POLICY.workspace, judgeForkPr: false }, {});
    assert.ok(d.action === "run" && d.ref === "refs/pull/7/head" && d.baseBranch === "main");
  });
  it("only opened, synchronize and reopened pull requests build", () => {
    for (const action of ["closed", "edited", "labeled"]) {
      assert.equal(
        decideWebhook("pull_request", { ...forkPr, action }, { ...POLICY.workspace, judgeForkPr: false }, {}).action,
        "ignore",
      );
    }
  });
  it("deleted refs and other events are ignored", () => {
    assert.equal(
      decideWebhook("push", push({ deleted: true, after: "0".repeat(40) }), POLICY.repo, {}).action,
      "ignore",
    );
    assert.equal(decideWebhook("issues", {}, POLICY.repo, {}).action, "ignore");
  });
});
