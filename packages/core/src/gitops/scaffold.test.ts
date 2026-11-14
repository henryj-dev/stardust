import assert from "node:assert/strict";
import { it } from "node:test";
import { parseAllDocuments } from "yaml";
import { manifestUsesImage, scaffoldComponent } from "./scaffold.ts";

it("finds a manifest that uses the component's image, whatever the registry", () => {
  const files = new Map([
    ["deploy/demo/api/deployment.yaml", "image: registry.example.com/demo/api:abc1234\n"],
    ["deploy/demo/api/README.md", "image: x/demo/api:1"],
  ]);
  assert.equal(manifestUsesImage(files, "demo", "api"), true);
  assert.equal(manifestUsesImage(files, "demo", "web"), false);
  assert.equal(manifestUsesImage(new Map([["a.md", "x/demo/api:1"]]), "demo", "api"), false, "only manifests count");
});

it("scaffolds a deliverable component: the image a delivery will bump, a Service for its port", () => {
  const files = scaffoldComponent({
    project: "demo",
    component: "api",
    namespace: "demo",
    imageRepository: "registry.example.com/demo/api",
    port: 8080,
  });
  assert.deepEqual([...files.keys()], ["deployment.yaml", "service.yaml", "kustomization.yaml"]);
  assert.equal(manifestUsesImage(files, "demo", "api"), true, "a delivery can bump it");
  for (const [name, text] of files) {
    for (const doc of parseAllDocuments(text)) assert.deepEqual(doc.errors, [], name);
  }
  const deployment = parseAllDocuments(files.get("deployment.yaml") ?? "")[0]?.toJS();
  assert.equal(deployment.spec.template.spec.containers[0].image, "registry.example.com/demo/api:pending");
  assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.deepEqual(parseAllDocuments(files.get("kustomization.yaml") ?? "")[0]?.toJS().resources, [
    "deployment.yaml",
    "service.yaml",
  ]);
  assert.equal(
    scaffoldComponent({
      project: "demo",
      component: "worker",
      namespace: "demo",
      imageRepository: "r.example.com/demo/worker",
    }).has("service.yaml"),
    false,
  );
  assert.throws(
    () => scaffoldComponent({ project: "demo", component: "Api", namespace: "demo", imageRepository: "r/x" }),
    /DNS label/,
  );
});
