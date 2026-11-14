import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findWorkloads, setReplicas, setResources, WorkloadEditError } from "./workloads.ts";

const DEPLOYMENT = `# the api
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: demo
spec:
  replicas: 2 # keep two
  selector:
    matchLabels:
      app: api
  template:
    spec:
      containers:
        - name: api
          image: registry.example.com/demo/api:1
        - name: sidecar
          image: registry.example.com/demo/sidecar:1
---
apiVersion: v1
kind: Service
metadata:
  name: api
`;

describe("workloads", () => {
  it("are found with their selector, replicas and containers; other kinds are not", () => {
    assert.deepEqual(findWorkloads(new Map([["deploy/demo/api/deployment.yaml", DEPLOYMENT]])), [
      {
        kind: "Deployment",
        name: "api",
        namespace: "demo",
        selector: { app: "api" },
        replicas: 2,
        containers: ["api", "sidecar"],
        file: "deploy/demo/api/deployment.yaml",
      },
    ]);
  });

  it("scale by changing only the replicas, keeping comments", () => {
    const { text, changed } = setReplicas(DEPLOYMENT, "Deployment", "api", 3);
    assert.equal(changed, true);
    assert.ok(text.includes("# the api"));
    assert.ok(text.includes("replicas: 3 # keep two"));
    assert.ok(text.includes("kind: Service"));
    assert.equal(setReplicas(DEPLOYMENT, "Deployment", "api", 2).changed, false);
  });

  it("refuse impossible scales and workloads that are not there", () => {
    assert.throws(() => setReplicas(DEPLOYMENT, "Deployment", "api", -1), WorkloadEditError);
    assert.throws(() => setReplicas(DEPLOYMENT, "Deployment", "api", 1.5), WorkloadEditError);
    assert.throws(() => setReplicas(DEPLOYMENT, "Deployment", "api", 1000), WorkloadEditError);
    assert.throws(() => setReplicas(DEPLOYMENT, "Deployment", "web", 1), /no Deployment web/);
    assert.throws(() => setReplicas(DEPLOYMENT, "DaemonSet", "api", 1), /no replicas/);
  });

  it("set one container's resources and refuse what Kubernetes would not take", () => {
    const { text } = setResources(DEPLOYMENT, "Deployment", "api", "sidecar", {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { memory: "128Mi" },
    });
    const sidecar = text.slice(text.indexOf("- name: sidecar"));
    assert.ok(sidecar.includes("cpu: 50m") && sidecar.includes("memory: 128Mi"), text);
    assert.ok(
      !text.slice(0, text.indexOf("- name: sidecar")).includes("resources"),
      "the other container is untouched",
    );
    assert.throws(
      () => setResources(DEPLOYMENT, "Deployment", "api", "nope", { limits: { cpu: "1" } }),
      /no container nope/,
    );
    assert.throws(() => setResources(DEPLOYMENT, "Deployment", "api", "api", { limits: { cpu: "lots" } }), /quantity/);
    assert.throws(
      () => setResources(DEPLOYMENT, "Deployment", "api", "api", { limits: { gpu: "1" } as never }),
      /unknown resource "gpu"/,
    );
  });
});
