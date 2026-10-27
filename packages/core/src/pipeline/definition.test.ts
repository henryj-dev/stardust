/**
 * Golden cases for definition validation, carried over from the predecessor
 * system: reference integrity, build kinds and cycle detection with the path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPipelineDef, PipelineDefError, pipelineDefFromComponents, validatePipelineDef } from "./definition.ts";

function rejects(value: unknown, pattern: RegExp): void {
  const result = validatePipelineDef(value);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, pattern);
}
const withJobs = (jobs: unknown) => ({ jobs });

describe("validatePipelineDef", () => {
  it("accepts a valid definition", () => {
    assert.deepEqual(validatePipelineDef(withJobs({ a: { pipeline: "C" }, b: { pipeline: "N", needs: ["a"] } })), {
      ok: true,
    });
  });
  it("rejects missing or empty jobs", () => {
    rejects({}, /jobs/);
    rejects(withJobs({}), /empty/);
    rejects("text", /not an object/);
  });
  it("pipeline must be W, C or N", () => {
    rejects(withJobs({ a: { pipeline: "X" } }), /W, C or N/);
  });
  it("needs must exist, must not be itself, must be an array", () => {
    rejects(withJobs({ a: { pipeline: "C", needs: ["zz"] } }), /does not exist/);
    rejects(withJobs({ a: { pipeline: "C", needs: ["a"] } }), /needs itself/);
    rejects(withJobs({ a: { pipeline: "C", needs: "a" } }), /array/);
  });
  it("detects 2- and 3-cycles and reports the path", () => {
    rejects(withJobs({ a: { pipeline: "C", needs: ["b"] }, b: { pipeline: "C", needs: ["a"] } }), /cycle: a -> b -> a/);
    rejects(
      withJobs({
        a: { pipeline: "C", needs: ["c"] },
        b: { pipeline: "C", needs: ["a"] },
        c: { pipeline: "C", needs: ["b"] },
      }),
      /cycle: a -> c -> b -> a/,
    );
  });
  it("accepts a diamond", () => {
    assert.deepEqual(
      validatePipelineDef(
        withJobs({
          a: { pipeline: "C" },
          b: { pipeline: "C", needs: ["a"] },
          c: { pipeline: "C", needs: ["a"] },
          d: { pipeline: "N", needs: ["b", "c"] },
        }),
      ),
      { ok: true },
    );
  });
  it("version is optional and must be 1 when present", () => {
    assert.deepEqual(validatePipelineDef({ version: 1, jobs: { a: { pipeline: "C" } } }), { ok: true });
    rejects({ version: 2, jobs: { a: { pipeline: "C" } } }, /unsupported version 2/);
  });
});

describe("loadPipelineDef", () => {
  it("returns a valid definition and throws PipelineDefError otherwise", () => {
    const def = loadPipelineDef({ jobs: { build: { pipeline: "C" }, test: { pipeline: "C", needs: ["build"] } } });
    assert.deepEqual(def.jobs.test?.needs, ["build"]);
    assert.throws(() => loadPipelineDef({ jobs: { a: { pipeline: "C", needs: ["a"] } } }), PipelineDefError);
  });
});

describe("pipelineDefFromComponents", () => {
  it("makes one manually triggered job per component; only C names its component", () => {
    assert.deepEqual(
      pipelineDefFromComponents([
        { name: "Dashboard", pipeline: "N" },
        { name: "api", pipeline: "C" },
      ]),
      {
        on: { workflow_dispatch: {} },
        jobs: { dashboard: { pipeline: "N" }, api: { pipeline: "C", component: "api" } },
      },
    );
  });
  it("rejects names that collide after lower-casing", () => {
    assert.throws(
      () =>
        pipelineDefFromComponents([
          { name: "API", pipeline: "C" },
          { name: "api", pipeline: "C" },
        ]),
      /duplicate component name "api"/,
    );
  });
});
