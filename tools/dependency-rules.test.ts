/**
 * Proves the boundary rules in .dependency-cruiser.cjs actually stop something.
 *
 * Each fixture under tools/fixtures/deps/<case>/ is a tiny repository that
 * breaks exactly one rule; the test asserts it is stopped by *that* rule, not
 * merely that "something failed". The clean fixture uses every allowed edge
 * and must pass. Finally, the real repository must contain at least one
 * cross-package edge — if the resolver stopped seeing workspace imports,
 * every rule would pass vacuously.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, ".dependency-cruiser.cjs");
const BIN = join(ROOT, "node_modules", ".bin", "depcruise");
const FIXTURES = join(ROOT, "tools", "fixtures", "deps");

interface CruiseResult {
  modules: { source: string; dependencies: { resolved: string }[] }[];
  summary: { violations: { rule: { name: string } }[] };
}

function cruise(cwd: string): CruiseResult {
  const targets = ["packages", "plugins"].filter((d) => readdirSync(cwd).includes(d));
  const run = spawnSync(BIN, ["--config", CONFIG, "--output-type", "json", ...targets], { cwd, encoding: "utf8" });
  assert.ok(run.stdout, `depcruise produced no output: ${run.stderr}`);
  return JSON.parse(run.stdout) as CruiseResult;
}

function ruleNames(result: CruiseResult): string[] {
  return [...new Set(result.summary.violations.map((v) => v.rule.name))].sort();
}

describe("dependency rules", () => {
  it("clean fixture has no violations", () => {
    assert.deepEqual(ruleNames(cruise(join(FIXTURES, "clean"))), []);
  });

  const cases = readdirSync(FIXTURES).filter((d) => d !== "clean");
  for (const name of cases) {
    const expected = name.replace(/-svelte$/, "");
    it(`${name} is stopped by ${expected}`, () => {
      assert.deepEqual(ruleNames(cruise(join(FIXTURES, name))), [expected]);
    });
  }

  it("the real repository has cross-package edges (rules are not vacuous)", () => {
    const edges = cruise(ROOT).modules.flatMap((m) => m.dependencies.map((d) => `${m.source} -> ${d.resolved}`));
    assert.ok(
      edges.some((e) => /^packages\/server\/.* -> packages\/config\/src\/index\.ts$/.test(e)),
      `no server -> config edge found; edges:\n${edges.join("\n")}`,
    );
  });
});
