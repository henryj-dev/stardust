import assert from "node:assert/strict";
import { it } from "node:test";
import { parseBuildEnv, parseFields, projectFields, readFields } from "./project-form.ts";

const form = (entries: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

it("reads components in index order, whatever order the fields arrive in", () => {
  const fields = readFields(
    form({
      name: " Demo ",
      githubRepo: "acme/demo",
      "components.7.name": "worker",
      "components.7.pipeline": "C",
      "components.7.deployDir": "apps/worker",
      "components.2.name": "web",
      "components.2.pipeline": "N",
      "components.2.deployDir": "apps/web",
    }),
    "demo",
  );
  assert.equal(fields.name, "Demo");
  assert.deepEqual(
    fields.components.map((c) => c.name),
    ["web", "worker"],
  );
  assert.equal(fields.components[0]?.dockerfile, "");
});

it("keeps only the fields of each pipeline: N gets port and build environment, C a Dockerfile", () => {
  const parsed = parseFields({
    id: "demo",
    name: "",
    githubRepo: "",
    components: [
      {
        name: "web",
        pipeline: "N",
        context: "app",
        dockerfile: "Dockerfile",
        port: "3000",
        buildEnv: "BUILD_TARGET=node\n\nQUERY=a=b",
        deployDir: "apps/web",
      },
      {
        name: "api",
        pipeline: "C",
        context: "",
        dockerfile: "api/Dockerfile",
        port: "8080",
        buildEnv: "X=1",
        deployDir: "apps/api",
      },
    ],
  });
  assert.deepEqual(parsed, {
    ok: true,
    name: "demo",
    githubRepo: null,
    components: [
      {
        name: "web",
        pipeline: "N",
        deployDir: "apps/web",
        context: "app",
        port: 3000,
        buildEnv: { BUILD_TARGET: "node", QUERY: "a=b" },
      },
      { name: "api", pipeline: "C", deployDir: "apps/api", dockerfile: "api/Dockerfile" },
    ],
  });
});

it("refuses what the form can tell is wrong, one message per problem", () => {
  const parsed = parseFields({
    id: "Demo",
    name: "",
    githubRepo: "",
    components: [
      { name: "web", pipeline: "N", context: "", dockerfile: "", port: "80a", buildEnv: "NOEQUALS", deployDir: "" },
      { name: "", pipeline: "X", context: "", dockerfile: "", port: "", buildEnv: "", deployDir: "d" },
    ],
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.errors, [
    "The project id must start with a letter and use only lower-case letters, digits and dashes.",
    "Component 1 (web): the deploy directory is required.",
    "Component 1 (web): the port must be a number from 1 to 65535.",
    "Component 1 (web): build environment line 1 is not KEY=VALUE.",
    "Component 2: choose a pipeline.",
  ]);
});

it("refuses a port out of range and a name given twice", () => {
  assert.deepEqual(parseBuildEnv("A=1\nA=2"), { ok: false, errors: ["build environment names A twice."] });
  const parsed = parseFields({
    id: "demo",
    name: "x",
    githubRepo: "",
    components: [
      { name: "w", pipeline: "N", context: "", dockerfile: "", port: "70000", buildEnv: "", deployDir: "d" },
    ],
  });
  assert.equal(parsed.ok, false);
});

it("fills the form from a stored project and reads it back to the same components", () => {
  const stored = {
    id: "demo",
    name: "Demo",
    githubRepo: "acme/demo",
    pipelineDef: null,
    metadata: {},
    components: [
      { name: "web", pipeline: "N" as const, port: 3000, buildEnv: { A: "1", B: "x=y" }, deployDir: "apps/web" },
      { name: "api", pipeline: "C" as const, context: "api", dockerfile: "Dockerfile.prod", deployDir: "apps/api" },
    ],
  };
  const fields = projectFields(stored);
  assert.equal(fields.components[0]?.buildEnv, "A=1\nB=x=y");
  const parsed = parseFields(fields);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.components, stored.components);
  assert.equal(parsed.githubRepo, "acme/demo");
});
