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
