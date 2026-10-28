import assert from "node:assert/strict";
import { it } from "node:test";
import { pullTarget } from "./app.ts";
import { compareApi, TargetError, targetApi } from "./source.ts";

const HEAD = "f".repeat(40);
const TAG = "c".repeat(40);
const OLD = "a".repeat(40);

/** A GitHub API stand-in: default branch main at HEAD, tag v1 at TAG, OLD in main's history. */
function host(over: Record<string, () => Response> = {}) {
  const seen: Array<{ path: string; auth: string | null }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://api.test/repos/", "");
    seen.push({ path, auth: new Headers(init?.headers).get("authorization") });
    const fixed = over[path];
    if (fixed) return fixed();
    switch (path) {
      case "acme/app":
        return Response.json({ default_branch: "main" });
      case "acme/app/commits/heads/main":
      case "acme/app/commits/heads/release/1":
        return Response.json({ sha: HEAD });
      case "acme/app/commits/tags/v1":
        return Response.json({ sha: TAG });
      case `acme/app/commits/${OLD}`:
        return Response.json({ sha: OLD });
      case `acme/app/compare/main...${OLD}`:
        return Response.json({ status: "behind" });
      default:
        return Response.json({ message: "No commit found" }, { status: 422 });
    }
  }) as typeof fetch;
  return { seen, fetchFn };
}

it("resolves the default branch, a branch, a tag and a commit in the default branch's history", async () => {
  const { seen, fetchFn } = host();
  const resolve = targetApi("https://api.test/", undefined, fetchFn);
  assert.deepEqual(await resolve("acme/app", {}), { ref: "refs/heads/main", sha: HEAD });
  assert.deepEqual(await resolve("acme/app", { branch: "release/1" }), { ref: "refs/heads/release/1", sha: HEAD });
  assert.deepEqual(await resolve("acme/app", { tag: "v1" }), { ref: "refs/tags/v1", sha: TAG });
  assert.deepEqual(await resolve("acme/app", { sha: OLD }), { ref: "refs/heads/main", sha: OLD });
  assert.ok(
    seen.every((s) => s.auth === null),
    "anonymous without a token",
  );
});

it("refuses a commit outside the default branch's history, such as one only in a fork", async () => {
  const forked = "b".repeat(40);
  const { fetchFn } = host({
    [`acme/app/commits/${forked}`]: () => Response.json({ sha: forked }),
    [`acme/app/compare/main...${forked}`]: () => Response.json({ status: "diverged" }),
  });
  await assert.rejects(targetApi("https://api.test", undefined, fetchFn)("acme/app", { sha: forked }), (err) => {
    assert.ok(err instanceof TargetError);
    assert.equal(err.notFound, true);
    assert.match(err.message, /not in the history of main/);
    return true;
  });
});

it("tells a missing ref (the operator's mistake) from a failing host", async () => {
  const { fetchFn } = host({ "acme/app/commits/heads/down": () => new Response("", { status: 503 }) });
  const resolve = targetApi("https://api.test", "t0k", fetchFn);
  await assert.rejects(resolve("acme/app", { tag: "v9" }), { notFound: true, message: "tag v9 was not found" });
  await assert.rejects(resolve("acme/app", { branch: "down" }), { notFound: false });
  const { fetchFn: odd } = host({ "acme/app/commits/tags/v1": () => Response.json({ sha: "nope" }) });
  await assert.rejects(targetApi("https://api.test", undefined, odd)("acme/app", { tag: "v1" }), { notFound: false });
});

it("sends the token when there is one, for both the compare and the target API", async () => {
  const { seen, fetchFn } = host({ "acme/app/compare/x...y": () => Response.json({ files: [] }) });
  await targetApi("https://api.test", "t0k", fetchFn)("acme/app", { tag: "v1" });
  await compareApi("https://api.test", "t0k", fetchFn)("acme/app", "x", "y");
  await compareApi("https://api.test", undefined, fetchFn)("acme/app", "x", "y");
  assert.deepEqual(
    seen.map((s) => s.auth),
    ["Bearer t0k", "Bearer t0k", null],
  );
});

it("parses a manual run's target, or says what is wrong with it", () => {
  assert.deepEqual(pullTarget({}), {});
  assert.deepEqual(pullTarget({ branch: "release/1.2" }), { branch: "release/1.2" });
  assert.deepEqual(pullTarget({ tag: "v2.7.0" }), { tag: "v2.7.0" });
  assert.deepEqual(pullTarget({ sha: OLD }), { sha: OLD });
  for (const bad of [
    { branch: "a", tag: "b" },
    { ref: "main" },
    { sha: "abc" },
    { sha: OLD.toUpperCase() },
    { branch: "../etc" },
    { branch: "a..b" },
    { branch: "-rf" },
    { branch: "/x" },
    { branch: "x/" },
    { branch: "a//b" },
    { tag: "v1 " },
    { tag: "v1\n" },
    { tag: "" },
    { branch: 1 },
  ]) {
    assert.equal(typeof pullTarget(bad as Record<string, unknown>), "string", JSON.stringify(bad));
  }
});
