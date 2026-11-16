/**
 * The release Job's build step, run for real in its node image: an app with
 * an npm lockfile and one with a pnpm lockfile install and build, and an app
 * without a lockfile is refused. Needs Docker and network access.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BUILD, DEFAULT_IMAGES } from "./job.ts";

const hasDocker = spawnSync("docker", ["version"]).status === 0;
const pkg = (name: string) =>
  JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
    scripts: { build: "mkdir -p dist && echo built > dist/index.js" },
  });

function app(lockfile: "npm" | "pnpm" | "none") {
  const root = mkdtempSync(join(tmpdir(), "stardust-w-"));
  const src = join(root, "src");
  mkdirSync(src);
  // The build runs as uid 1000, which owns neither directory on a CI runner.
  chmodSync(root, 0o777);
  chmodSync(src, 0o777);
  writeFileSync(join(src, "package.json"), pkg("fixture"));
  if (lockfile === "npm") {
    writeFileSync(
      join(src, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "fixture", version: "1.0.0" } },
      }),
    );
  }
  if (lockfile === "pnpm")
    writeFileSync(join(src, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n");
  return root;
}

const build = (root: string) =>
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "-v",
      `${root}:/workspace`,
      "-e",
      "HOME=/workspace/home",
      "-e",
      "CONTEXT=.",
      DEFAULT_IMAGES.node,
      "/bin/sh",
      "-c",
      BUILD,
    ],
    { encoding: "utf8" },
  );

it("installs with the lockfile's package manager and builds; refuses an app without a lockfile", {
  skip: !hasDocker && "Docker is not available",
  timeout: 300_000,
}, () => {
  for (const kind of ["npm", "pnpm"] as const) {
    const root = app(kind);
    const r = build(root);
    assert.equal(r.status, 0, `${kind}: ${r.stdout}\n${r.stderr}`);
    assert.ok(existsSync(join(root, "src/dist/index.js")), `${kind}: built`);
  }
  const r = build(app("none"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no lockfile/);
});
