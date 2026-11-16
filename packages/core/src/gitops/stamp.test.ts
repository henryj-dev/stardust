import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAllDocuments } from "yaml";
import { stampPodTemplate } from "./stamp.ts";

const KEY = "stardust.io/env-revision";
const DEPLOYMENT = `# api — the public API.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    metadata:
      labels: { app: api }
      annotations:
        prometheus.io/scrape: "true" # keep this
    spec:
      containers:
        - name: api
          image: registry.example.com/demo/api:abc1234
`;
type Doc = {
  kind?: string;
  spec: { template?: { metadata: { annotations: Record<string, string> } } };
};
const read = (text: string, i = 0) => parseAllDocuments(text)[i]?.toJS() as Doc;
const annotations = (text: string, i = 0) => read(text, i).spec.template?.metadata.annotations ?? {};

describe("stampPodTemplate", () => {
  it("adds the annotation to the pod template and keeps comments and other annotations", () => {
    const out = stampPodTemplate(DEPLOYMENT, KEY, "r1");
    assert.equal(out.stamped, 1);
    assert.equal(out.changed, true);
    assert.equal(annotations(out.text)[KEY], "r1");
    assert.equal(annotations(out.text)["prometheus.io/scrape"], "true");
    assert.ok(out.text.includes("# api — the public API."));
    assert.ok(out.text.includes("# keep this"));
  });
  it("is a no-op when the value is already there, returning the text untouched", () => {
    const once = stampPodTemplate(DEPLOYMENT, KEY, "r1").text;
    const again = stampPodTemplate(once, KEY, "r1");
    assert.equal(again.changed, false);
    assert.equal(again.text, once);
  });
  it("creates metadata and annotations when the template has none", () => {
    const bare =
      "apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: db\nspec:\n  template:\n    spec:\n      containers: []\n";
    assert.equal(annotations(stampPodTemplate(bare, KEY, "r2").text)[KEY], "r2");
  });
  it("stamps only workloads in a multi-document file", () => {
    const multi = `apiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  ports: [{ port: 80 }]\n---\n${DEPLOYMENT}`;
    const out = stampPodTemplate(multi, KEY, "r3");
    assert.equal(out.stamped, 1);
    assert.equal(read(out.text, 0).kind, "Service");
    assert.equal(read(out.text, 0).spec.template, undefined, "the Service gained nothing");
    assert.equal(annotations(out.text, 1)[KEY], "r3");
  });
  it("reports zero when nothing in the file is a workload", () => {
    const out = stampPodTemplate("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n", KEY, "r");
    assert.deepEqual([out.stamped, out.changed], [0, false]);
  });
  it("refuses a file that does not parse instead of rewriting it", () => {
    assert.throws(() => stampPodTemplate("kind: Deployment\nspec: [unclosed\n", KEY, "r"), /cannot parse/);
  });
});

describe("stampPodTemplate keeps the file as it was written", () => {
  const KEY = "stardust.dev/env-revision";
  const head = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api  # two spaces before this comment
spec:
  template:
`;
  const tail = `    spec:
      containers:
        - name: api
          args: [--port, "8080"]
          image: registry.example.com/demo/api:1
`;
  const parsed = (text: string) => parseAllDocuments(text).map((d) => d.toJS());

  it("replaces an existing value where it is, and nothing else", () => {
    const text = `${head}    metadata:
      annotations:
        ${KEY}: "old"   # set by stardust
        other: x
${tail}`;
    const out = stampPodTemplate(text, KEY, "new").text;
    assert.equal(out, text.replace('"old"', '"new"'));
  });

  it("adds a line to existing annotations", () => {
    const text = `${head}    metadata:
      annotations:
        other: x  # keep
${tail}`;
    const out = stampPodTemplate(text, KEY, "r1").text;
    assert.equal(out, text.replace("other: x  # keep", `other: x  # keep\n        ${KEY}: "r1"`));
    assert.equal(parsed(out)[0].spec.template.metadata.annotations[KEY], "r1");
  });

  it("adds annotations to existing metadata, and metadata to a template without it", () => {
    const withMeta = `${head}    metadata:
      labels:
        app: api
${tail}`;
    const a = stampPodTemplate(withMeta, KEY, "r2").text;
    assert.ok(a.includes(`        app: api\n      annotations:\n        ${KEY}: "r2"\n`), a);
    assert.equal(parsed(a)[0].spec.template.metadata.labels.app, "api");

    const bare = `${head}${tail}`;
    const b = stampPodTemplate(bare, KEY, "r3").text;
    assert.equal(parsed(b)[0].spec.template.metadata.annotations[KEY], "r3");
    assert.deepEqual(parsed(b)[0].spec.template.spec, parsed(bare)[0].spec.template.spec);
    for (const out of [a, b]) {
      assert.ok(out.includes("name: api  # two spaces before this comment"));
      assert.ok(out.includes('args: [--port, "8080"]'), "a flow sequence is not re-spaced");
    }
  });
});
