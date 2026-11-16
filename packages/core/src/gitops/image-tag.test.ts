/**
 * Fixed here: a second manifest next to deployment.yaml is updated; "nothing
 * to commit" and "no reference at all" stay apart; partial drift commits only
 * the lagging file; SOPS files are never touched; other components' images
 * are left alone. Fixtures sit on those boundaries rather than being all-same
 * or all-different.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  imageRefTag,
  imageTagPattern,
  isBumpCandidate,
  orderBumpCandidates,
  planDirectoryRewrite,
  rewriteBuildRev,
  rewriteImageTag,
} from "./image-tag.ts";

const dep = (tag: string) =>
  `spec:\n  template:\n    spec:\n      containers:\n        - name: manager\n          image: registry.example.com/hp/manager:${tag}\n`;
/** A renderer with two containers using the same image. */
const render = (tag: string) =>
  `spec:\n  template:\n    spec:\n      containers:\n        - name: render\n          image: registry.example.com/hp/manager:${tag}\n        - name: sidecar\n          image: registry.example.com/hp/manager:${tag}\n`;
const DIGEST = "a".repeat(64);
const DIGEST2 = "b".repeat(64);

describe("rewriteImageTag", () => {
  it("rewrites the tag and counts matches and changes separately", () => {
    const r = rewriteImageTag(render("old1111"), "hp", "manager", "new2222");
    assert.equal(r.matched, 2);
    assert.equal(r.changed, 2);
    assert.deepEqual(r.oldTags, ["old1111"]);
    assert.ok(!r.text.includes("old1111"));
  });
  it("counts an up-to-date reference as matched but not changed", () => {
    const r = rewriteImageTag(dep("new2222"), "hp", "manager", "new2222");
    assert.equal(r.matched, 1);
    assert.equal(r.changed, 0);
  });
  it("matches whatever the registry host", () => {
    const r = rewriteImageTag("image: other.host:5000/hp/manager:x\n", "hp", "manager", "y");
    assert.equal(r.text, "image: other.host:5000/hp/manager:y\n");
  });
  it("leaves other components and projects alone, even in the same file", () => {
    const text = `${dep("old")}          image: registry.example.com/hp/worker:old\n          image: registry.example.com/other/manager:old\n`;
    const r = rewriteImageTag(text, "hp", "manager", "new");
    assert.equal(r.changed, 1);
    assert.match(r.text, /hp\/worker:old/);
    assert.match(r.text, /other\/manager:old/);
  });
  it("treats regex characters in names literally", () => {
    assert.equal(imageTagPattern("a.b", "c+d").test("r/aXb/c+d:t"), false);
    assert.equal(imageTagPattern("a.b", "c+d").test("r/a.b/c+d:t"), true);
  });
});

describe("digest references — same SHA, new content, new rollout", () => {
  it("imageRefTag pins to the digest when it has one", () => {
    assert.equal(imageRefTag("abc1234", DIGEST), `abc1234@sha256:${DIGEST}`);
    assert.equal(imageRefTag("abc1234", `sha256:${DIGEST}`), `abc1234@sha256:${DIGEST}`);
    assert.equal(imageRefTag("abc1234", null), "abc1234");
    assert.equal(imageRefTag("abc1234", "nonsense"), "abc1234");
  });
  it("a changed digest on the same SHA is a change", () => {
    const pinned = rewriteImageTag(dep("abc1234"), "hp", "manager", "abc1234", DIGEST).text;
    const again = rewriteImageTag(pinned, "hp", "manager", "abc1234", DIGEST2);
    assert.equal(again.changed, 1);
    assert.match(again.text, new RegExp(`manager:abc1234@sha256:${DIGEST2}\\n`));
  });
  it("the same SHA and digest is not a change", () => {
    const pinned = rewriteImageTag(dep("abc1234"), "hp", "manager", "abc1234", DIGEST).text;
    assert.equal(rewriteImageTag(pinned, "hp", "manager", "abc1234", DIGEST).changed, 0);
  });
  it("replaces a pinned reference whole, without leaving the old digest behind", () => {
    const pinned = rewriteImageTag(dep("old1111"), "hp", "manager", "old1111", DIGEST).text;
    const r = rewriteImageTag(pinned, "hp", "manager", "new2222");
    assert.match(r.text, /manager:new2222\n/);
    assert.ok(!r.text.includes(DIGEST));
  });
});

describe("rewriteBuildRev — only where the annotation exists", () => {
  const ANNOTATION = "example.com/build-rev";
  const withRev = (v: string) => `metadata:\n  annotations:\n    ${ANNOTATION}: "${v}"\n`;
  it("sets the value and counts the change", () => {
    assert.deepEqual(rewriteBuildRev(withRev("1"), ANNOTATION, "2"), { text: withRev("2"), changed: 1 });
    assert.equal(rewriteBuildRev(withRev("2"), ANNOTATION, "2").changed, 0);
  });
  it("leaves manifests without the annotation untouched", () => {
    assert.deepEqual(rewriteBuildRev(dep("x"), ANNOTATION, "2"), { text: dep("x"), changed: 0 });
  });
  it("in a directory plan, a new rev is a change even when the tag is the same", () => {
    const files = new Map([["deployment.yaml", `${withRev("old")}${dep("abc1234")}`]]);
    const p = planDirectoryRewrite(files, {
      project: "hp",
      component: "manager",
      shortSha: "abc1234",
      buildRev: "job-2",
      buildRevAnnotation: ANNOTATION,
    });
    assert.equal(p.toCommit.length, 1);
    assert.match(p.toCommit[0]?.text ?? "", /build-rev: "job-2"/);
  });
});

describe("candidates", () => {
  it("YAML files are candidates, SOPS files and others are not", () => {
    for (const n of ["deployment.yaml", "cron.yml", "Kustomization.YAML"]) assert.equal(isBumpCandidate(n), true, n);
    for (const n of ["env.secret.enc.yaml", "x.enc.yml", "README.md", "values.json"]) {
      assert.equal(isBumpCandidate(n), false, n);
    }
  });
  it("deployment.yaml first, then by name", () => {
    assert.deepEqual(orderBumpCandidates(["z.yaml", "deployment.yaml", "a.yaml"]), [
      "deployment.yaml",
      "a.yaml",
      "z.yaml",
    ]);
    assert.deepEqual(orderBumpCandidates(["z.yaml", "a.yaml"]), ["a.yaml", "z.yaml"]);
  });
});

describe("planDirectoryRewrite", () => {
  const plan = (files: Record<string, string>, shortSha = "3e1c248") =>
    planDirectoryRewrite(new Map(Object.entries(files)), { project: "hp", component: "manager", shortSha });

  it("① the second manifest next to deployment.yaml is updated too", () => {
    const p = plan({ "deployment.yaml": dep("b32a7c6"), "policy-render.yaml": render("b32a7c6") });
    assert.deepEqual(
      p.toCommit.map((f) => f.name),
      ["deployment.yaml", "policy-render.yaml"],
    );
    assert.equal(p.toCommit[1]?.changed, 2);
  });
  it("③ partial drift: only the lagging file is committed; both are referencing", () => {
    const p = plan({ "deployment.yaml": dep("3e1c248"), "policy-render.yaml": render("b32a7c6") });
    assert.deepEqual(
      p.toCommit.map((f) => f.name),
      ["policy-render.yaml"],
    );
    assert.deepEqual(
      p.referencing.map((f) => f.name),
      ["deployment.yaml", "policy-render.yaml"],
    );
    assert.deepEqual(p.toCommit[0]?.oldTags, ["b32a7c6"]);
  });
  it("② up to date: nothing to commit, but the reference is there", () => {
    const p = plan({ "deployment.yaml": dep("3e1c248") });
    assert.equal(p.toCommit.length, 0);
    assert.equal(p.referencing.length, 1);
  });
  it("② no reference at all: both empty — the coordinates are wrong", () => {
    const p = plan({ "kustomization.yaml": "resources:\n  - deployment.yaml\n", "service.yaml": "kind: Service\n" });
    assert.equal(p.toCommit.length, 0);
    assert.equal(p.referencing.length, 0);
  });
  it("④ SOPS files are skipped even with the image in plain text", () => {
    const p = plan({
      "deployment.yaml": dep("b32a7c6"),
      "env.secret.enc.yaml": "metadata:\n  annotations:\n    from: registry.example.com/hp/manager:b32a7c6\n",
    });
    assert.deepEqual(
      p.referencing.map((f) => f.name),
      ["deployment.yaml"],
    );
  });
  it("four manifests sharing one image: all lagging are committed, deployment.yaml first", () => {
    const img = (tag: string) => `image: registry.example.com/sd/dispatcher:${tag}\n`;
    const files = new Map([
      ["deployment.yaml", img("old")],
      ["deployment-edge.yaml", img("new2222")],
      ["cron-runner.yaml", img("old")],
      ["vworld-proxy.yaml", img("old")],
    ]);
    const p = planDirectoryRewrite(files, { project: "sd", component: "dispatcher", shortSha: "new2222" });
    assert.deepEqual(
      p.toCommit.map((f) => f.name),
      ["deployment.yaml", "cron-runner.yaml", "vworld-proxy.yaml"],
    );
    assert.equal(p.referencing.length, 4);
  });
});
