import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envLanding, findSecretConsumers, type WorkloadLike } from "./consumers.ts";

const workload = (name: string, spec: WorkloadLike["spec"]["template"]["spec"], namespace = "demo"): WorkloadLike => ({
  kind: "Deployment",
  metadata: { name, namespace },
  spec: { template: { spec } },
});

const workloads: WorkloadLike[] = [
  workload("whole", { containers: [{ envFrom: [{ secretRef: { name: "api-env-secret" } }] }] }),
  workload("one-key", { containers: [{ env: [{ valueFrom: { secretKeyRef: { name: "api-env-secret" } } }] }] }),
  workload("files", { containers: [{}], volumes: [{ secret: { secretName: "api-env-secret" } }] }),
  workload("init", { initContainers: [{ envFrom: [{ secretRef: { name: "api-env-secret" } }] }], containers: [{}] }),
  workload("pull-only", { containers: [{}], imagePullSecrets: [{ name: "api-env-secret" }] }),
  workload("unrelated", { containers: [{ envFrom: [{ secretRef: { name: "other" } }] }] }),
  workload("other-namespace", { containers: [{ envFrom: [{ secretRef: { name: "api-env-secret" } }] }] }, "elsewhere"),
];

describe("findSecretConsumers", () => {
  const found = Object.fromEntries(findSecretConsumers(workloads, "demo", "api-env-secret").map((c) => [c.name, c]));

  it("finds all three reference forms, including mounted files and init containers", () => {
    assert.deepEqual(found.whole?.via, ["envFrom"]);
    assert.deepEqual(found["one-key"]?.via, ["envKey"]);
    assert.deepEqual(found.files?.via, ["volume"]);
    assert.deepEqual(found.init?.via, ["envFrom"]);
  });
  it("reports pull-secret-only use but does not restart it", () => {
    assert.equal(found["pull-only"]?.restartable, false);
    assert.equal(found.files?.restartable, true);
  });
  it("ignores other Secrets and other namespaces", () => {
    assert.equal(found.unrelated, undefined);
    assert.equal(found["other-namespace"], undefined);
  });
  it("finds nothing for a Secret nobody uses — the caller must say so", () => {
    assert.deepEqual(findSecretConsumers(workloads, "demo", "nobody"), []);
  });
});

describe("envLanding", () => {
  const R = "abc";
  const objects = { configMap: { revision: R }, secret: { revision: R } };
  it("committed but not applied while the objects lack the revision", () => {
    assert.equal(envLanding({ configMap: null, secret: null, workload: null }, R), "committed-not-applied");
    assert.equal(
      envLanding({ configMap: { revision: R }, secret: { revision: "old" }, workload: null }, R),
      "committed-not-applied",
    );
  });
  it("applied but not rolled out until the workload's template carries it and finished rolling", () => {
    assert.equal(
      envLanding({ ...objects, workload: { templateRevision: "old", rolledOut: true } }, R),
      "applied-not-rolled-out",
    );
    assert.equal(
      envLanding({ ...objects, workload: { templateRevision: R, rolledOut: false } }, R),
      "applied-not-rolled-out",
    );
  });
  it("live only when the pods run with it; no workload means no consumer", () => {
    assert.equal(envLanding({ ...objects, workload: { templateRevision: R, rolledOut: true } }, R), "live");
    assert.equal(envLanding({ ...objects, workload: null }, R), "no-consumer");
  });
});
