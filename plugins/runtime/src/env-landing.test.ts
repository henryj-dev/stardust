import assert from "node:assert/strict";
import { it } from "node:test";
import { buildFeatures, ENV_REVISION_ANNOTATION, type KubeStreamClient, type Logger } from "@stardust/core";
import { MemoryRepo } from "@stardust/core/testing";
import { plugin } from "./index.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DIR = "deploy/demo/api";
const R = "0123456789abcdef";

function landing(cluster: { applied: string | null; template: string | null; updated: number }) {
  const kube: KubeStreamClient = {
    async request(_m, path) {
      if (path === "/api/v1/namespaces/demo/configmaps/api-env")
        return cluster.applied === null
          ? { status: 404, body: "" }
          : {
              status: 200,
              body: JSON.stringify({ metadata: { annotations: { [ENV_REVISION_ANNOTATION]: cluster.applied } } }),
            };
      if (path === "/apis/apps/v1/namespaces/demo/deployments/api")
        return {
          status: 200,
          body: JSON.stringify({
            metadata: { generation: 3 },
            spec: {
              replicas: 2,
              template: {
                metadata: { annotations: cluster.template ? { [ENV_REVISION_ANNOTATION]: cluster.template } : {} },
              },
            },
            status: { observedGeneration: 3, updatedReplicas: cluster.updated, availableReplicas: cluster.updated },
          }),
        };
      return { status: 404, body: "" };
    },
    stream: () => Promise.reject(new Error("unused")),
  };
  const repo = new MemoryRepo({
    [`${DIR}/deployment.yaml`]:
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  namespace: demo\nspec:\n  selector:\n    matchLabels: { app: api }\n  template:\n    spec:\n      containers: []\n",
    [`${DIR}/env.configmap.yaml`]: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: api-env\n  namespace: demo\n  annotations:\n    ${ENV_REVISION_ANNOTATION}: ${R}\ndata: {}\n`,
  });
  const projects = {
    get: async () => ({ id: "demo", name: "Demo", githubRepo: null, components: [{ name: "api", deployDir: DIR }] }),
  };
  const [feature] = buildFeatures([plugin], { runtime: {} }, { kube, deployRepo: { repo }, projects }, quiet, "test");
  const route = feature?.routes.find((r) => r.path === "/projects/:project/components/:component/env");
  return route?.handle({
    params: { project: "demo", component: "api" },
    query: new URLSearchParams(),
    body: null,
    user: { id: "u", username: "u", isAdmin: true },
    signal: new AbortController().signal,
  });
}

it("says whether a committed env change has reached the cluster and rolled out", async () => {
  const state = async (cluster: Parameters<typeof landing>[0]) =>
    ((await landing(cluster))?.body as { landing: Array<{ state: string }> } | undefined)?.landing[0]?.state;
  assert.equal(await state({ applied: null, template: null, updated: 2 }), "committed-not-applied");
  assert.equal(await state({ applied: "old", template: "old", updated: 2 }), "committed-not-applied");
  assert.equal(await state({ applied: R, template: R, updated: 1 }), "applied-not-rolled-out");
  assert.equal(await state({ applied: R, template: R, updated: 2 }), "live");
  assert.equal(await state({ applied: R, template: null, updated: 2 }), "no-consumer");
  const body = (await landing({ applied: R, template: R, updated: 2 }))?.body as { revision: string };
  assert.equal(body.revision, R);
});
