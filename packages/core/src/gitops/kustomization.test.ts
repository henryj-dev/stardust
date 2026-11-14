/**
 * Getting this wrong stops deployments: a list entry without its file breaks
 * the build, a file without its entry is silently ignored. Fixed here:
 * comments survive, edits are idempotent, only our entries change, and the
 * indentation is read from the file — including column 0.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addResource, listResources, removeResource } from "./kustomization.ts";

const YAML = `# certs — the source of truth for served certificates.
#
# Do not put TLS secrets in Git.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - rbac.yaml
  # Added after the Secret existed, so it became Ready without reissuing.
  - wildcard.yaml
`;

const COLUMN_ZERO = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
# a column-0 comment inside the list
- service.yaml
namespace: demo
`;

describe("listResources", () => {
  it("skips comments and blank lines", () => {
    assert.deepEqual(listResources(YAML), ["namespace.yaml", "rbac.yaml", "wildcard.yaml"]);
  });
  it("returns nothing without resources:", () => {
    assert.deepEqual(listResources("kind: Kustomization\n"), []);
  });
  it("does not swallow the next top-level key", () => {
    assert.deepEqual(listResources(`${YAML}namespace: x\n`), ["namespace.yaml", "rbac.yaml", "wildcard.yaml"]);
  });
  it("reads a column-0 list through a column-0 comment", () => {
    assert.deepEqual(listResources(COLUMN_ZERO), ["deployment.yaml", "service.yaml"]);
  });
});

describe("addResource", () => {
  it("appends after the last entry with the same indentation", () => {
    const out = addResource(YAML, "new.yaml");
    assert.deepEqual(listResources(out), ["namespace.yaml", "rbac.yaml", "wildcard.yaml", "new.yaml"]);
    assert.match(out, /\n {2}- wildcard\.yaml\n {2}- new\.yaml\n/);
  });
  it("keeps every comment", () => {
    const out = addResource(YAML, "new.yaml");
    for (const line of YAML.split("\n").filter((l) => l.trim().startsWith("#"))) assert.ok(out.includes(line), line);
  });
  it("is idempotent", () => {
    assert.equal(addResource(YAML, "rbac.yaml"), YAML);
  });
  it("stays a valid list after several additions", () => {
    let out = YAML;
    for (const f of ["a.yaml", "b.yaml", "c.yaml"]) out = addResource(out, f);
    assert.deepEqual(listResources(out), [
      "namespace.yaml",
      "rbac.yaml",
      "wildcard.yaml",
      "a.yaml",
      "b.yaml",
      "c.yaml",
    ]);
  });
  it("throws instead of passing silently when there is no resources:", () => {
    assert.throws(() => addResource("kind: Kustomization\n", "x.yaml"), /no `resources:`/);
  });
  it("adds to a column-0 list at column 0, not with two spaces", () => {
    const out = addResource(COLUMN_ZERO, "config.yaml");
    assert.match(out, /\n- service\.yaml\n- config\.yaml\nnamespace: demo\n/);
    assert.deepEqual(listResources(out), ["deployment.yaml", "service.yaml", "config.yaml"]);
    assert.equal(addResource(out, "config.yaml"), out, "and a second add is a no-op");
  });
});

describe("removeResource", () => {
  it("removes only that entry", () => {
    assert.deepEqual(listResources(removeResource(YAML, "rbac.yaml")), ["namespace.yaml", "wildcard.yaml"]);
  });
  it("is idempotent", () => {
    assert.equal(removeResource(YAML, "missing.yaml"), YAML);
  });
  it("keeps comments", () => {
    assert.ok(removeResource(YAML, "wildcard.yaml").includes("# Added after the Secret existed"));
  });
  it("does not remove partial matches", () => {
    const yaml = "resources:\n  - a.yaml\n  - aa.yaml\n  - a.yaml.bak\n";
    assert.deepEqual(listResources(removeResource(yaml, "a.yaml")), ["aa.yaml", "a.yaml.bak"]);
  });
  it("add then remove restores the original", () => {
    assert.equal(removeResource(addResource(YAML, "tmp.yaml"), "tmp.yaml"), YAML);
  });
  it("removes from a column-0 list without ending the list at its first item", () => {
    const out = removeResource(COLUMN_ZERO, "service.yaml");
    assert.deepEqual(listResources(out), ["deployment.yaml"]);
    assert.match(out, /namespace: demo/);
  });
});
