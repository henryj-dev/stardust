import assert from "node:assert/strict";
import { it } from "node:test";
import { type Project, validateProject } from "./projects.ts";

const project = (components: Project["components"]): Project => ({
  id: "counter",
  name: "Counter",
  githubRepo: "upstream/counter",
  pipelineDef: null,
  components,
  metadata: { trust: "external" },
});
const DIGEST = `sha256:${"e".repeat(64)}`;

it("takes a mirrored component only with an image pinned by digest, and the image only for mirrors", () => {
  validateProject(
    project([
      { name: "app", pipeline: "M", image: `docker.io/upstream/counter:2.7@${DIGEST}`, deployDir: "apps/counter" },
    ]),
  );
  assert.throws(
    () =>
      validateProject(
        project([{ name: "app", pipeline: "M", image: "docker.io/upstream/counter:2.7", deployDir: "apps/counter" }]),
      ),
    /pinned by digest/,
  );
  assert.throws(
    () => validateProject(project([{ name: "app", pipeline: "M", deployDir: "apps/counter" }])),
    /pinned by digest/,
  );
  assert.throws(
    () => validateProject(project([{ name: "app", pipeline: "C", image: `docker.io/x/y@${DIGEST}`, deployDir: "a" }])),
    /pipeline M only/,
  );
});

it("lets a Worker have build env, but not a container build", () => {
  validateProject(
    project([{ name: "web", pipeline: "W", buildEnv: { PUBLIC_API: "https://api.example.com" }, deployDir: "a" }]),
  );
  assert.throws(
    () => validateProject(project([{ name: "api", pipeline: "C", buildEnv: { X: "y" }, deployDir: "a" }])),
    /pipelines N and W only/,
  );
  assert.throws(
    () => validateProject(project([{ name: "web", pipeline: "W", port: 3000, deployDir: "a" }])),
    /pipeline N only/,
  );
});
