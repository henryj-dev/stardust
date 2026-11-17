import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import {
  readPullSecrets,
  registryPullDocument,
  registryPullSecretName,
  runtimeBindingDocument,
  setPullSecret,
} from "./access.ts";
import { scaffoldComponent } from "./scaffold.ts";

const deployment =
  scaffoldComponent({
    project: "pico",
    component: "push",
    namespace: "pico",
    imageRepository: "registry.example.com/pico/push",
    port: 8788,
  }).get("deployment.yaml") ?? "";

type Spec = { imagePullSecrets?: Array<{ name: string }> };
const specOf = (text: string) => (parse(text) as { spec: { template: { spec: Spec } } }).spec.template.spec;

describe("a component's cluster access", () => {
  it("writes a pull Secret for the registry host, for the caller to seal", () => {
    const doc = parse(
      registryPullDocument({
        component: "push",
        namespace: "pico",
        login: { host: "registry.example.com", username: "puller", password: "pw" },
      }),
    ) as {
      metadata: { name: string; namespace: string };
      type: string;
      stringData: Record<string, string>;
    };
    assert.equal(doc.metadata.name, registryPullSecretName("push"));
    assert.equal(doc.metadata.namespace, "pico");
    assert.equal(doc.type, "kubernetes.io/dockerconfigjson");
    const config = JSON.parse(doc.stringData[".dockerconfigjson"] ?? "{}") as {
      auths: Record<string, { username: string; auth: string }>;
    };
    assert.equal(config.auths["registry.example.com"]?.username, "puller");
    assert.equal(Buffer.from(config.auths["registry.example.com"]?.auth ?? "", "base64").toString(), "puller:pw");
  });

  it("binds the chart's read-only ClusterRole in the namespace alone", () => {
    const doc = parse(
      runtimeBindingDocument({
        component: "push",
        namespace: "pico",
        grant: {
          clusterRole: "stardust-runtime-read",
          serviceAccount: "stardust-server",
          serviceAccountNamespace: "stardust",
        },
      }),
    ) as {
      kind: string;
      metadata: { namespace: string };
      roleRef: { kind: string; name: string };
      subjects: unknown[];
    };
    assert.equal(doc.kind, "RoleBinding");
    assert.equal(doc.metadata.namespace, "pico");
    assert.deepEqual(doc.roleRef, {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "stardust-runtime-read",
    });
    assert.deepEqual(doc.subjects, [{ kind: "ServiceAccount", name: "stardust-server", namespace: "stardust" }]);
  });

  it("adds and removes its pull Secret, keeping the others a workload names", () => {
    const own = deployment.replace(
      "      securityContext:\n        runAsNonRoot",
      "      imagePullSecrets:\n        - name: zot-pull-auth\n      securityContext:\n        runAsNonRoot",
    );
    const on = setPullSecret(own, "push-registry-pull", true);
    assert.equal(on.changed, true);
    assert.equal(on.workloads, 1);
    assert.deepEqual(specOf(on.text).imagePullSecrets, [{ name: "zot-pull-auth" }, { name: "push-registry-pull" }]);
    assert.deepEqual(readPullSecrets(on.text), ["zot-pull-auth", "push-registry-pull"]);
    assert.equal(setPullSecret(on.text, "push-registry-pull", true).changed, false);
    const off = setPullSecret(on.text, "push-registry-pull", false);
    assert.deepEqual(specOf(off.text).imagePullSecrets, [{ name: "zot-pull-auth" }]);
  });

  it("creates the list when there is none, and drops it when it empties", () => {
    const on = setPullSecret(deployment, "push-registry-pull", true);
    assert.deepEqual(specOf(on.text).imagePullSecrets, [{ name: "push-registry-pull" }]);
    assert.equal(specOf(setPullSecret(on.text, "push-registry-pull", false).text).imagePullSecrets, undefined);
  });

  it("leaves a document without a workload alone", () => {
    const service = "apiVersion: v1\nkind: Service\nmetadata:\n  name: push\n";
    assert.deepEqual(setPullSecret(service, "x", true), { text: service, workloads: 0, changed: false });
  });

  it("makes an exposed Service a LoadBalancer, and needs a port to expose", () => {
    const files = scaffoldComponent({
      project: "pico",
      component: "push",
      namespace: "pico",
      imageRepository: "registry.example.com/pico/push",
      port: 8788,
      expose: true,
    });
    assert.equal((parse(files.get("service.yaml") ?? "") as { spec: { type: string } }).spec.type, "LoadBalancer");
    assert.throws(
      () =>
        scaffoldComponent({
          project: "pico",
          component: "push",
          namespace: "pico",
          imageRepository: "registry.example.com/pico/push",
          expose: true,
        }),
      /exposing needs a port/,
    );
  });
});
