import assert from "node:assert/strict";
import { it } from "node:test";
import { checkDeployDirTemplate, deployDirFor } from "./deploy-dir.ts";

it("fills a project's and a component's names into the template", () => {
  const t = "deploy/clusters/one/apps/{project}/{component}";
  assert.equal(checkDeployDirTemplate(t), null);
  assert.equal(deployDirFor(t, "pico", "push"), "deploy/clusters/one/apps/pico/push");
  assert.equal(checkDeployDirTemplate("apps/{component}"), null);
});

it("refuses a template that would not give each component its own plain directory", () => {
  for (const [t, why] of [
    ["", /must be a path/],
    ["/apps/{component}", /relative/],
    ["apps/{component}/", /relative/],
    ["apps/{project}", /must contain \{component\}/],
    ["apps/{env}/{component}", /\{env\} is not a placeholder/],
    ["apps/../{component}", /plain path segments/],
    ["apps//{component}", /plain path segments/],
    ["apps/a b/{component}", /plain path segments/],
  ] as const) {
    assert.match(checkDeployDirTemplate(t) ?? "", why, t);
  }
  assert.match(checkDeployDirTemplate(3) ?? "", /must be a path/);
});
