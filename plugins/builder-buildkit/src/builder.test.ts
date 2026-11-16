/** A build with a one-time clone token: its Secret exists before any pod, belongs to the Job, and the build container never sees it. */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { KubeStreamClient } from "@stardust/core";
import { createBuilder } from "./builder.ts";

const DIGEST = `sha256:${"d".repeat(64)}`;
const request = {
  projectId: "shop",
  repo: "acme/shop",
  sha: "a".repeat(40),
  component: "api",
  runId: "r1",
  jobName: "api",
  cloneToken: "ghs_one-repo",
};

function fakeKube(failSecret = false) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const kube: KubeStreamClient = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === "POST" && path.endsWith("/jobs")) {
        const name = (body as { metadata: { name: string } }).metadata.name;
        return { status: 201, body: JSON.stringify({ metadata: { name, uid: "job-uid-1" } }) };
      }
      if (method === "POST" && path.endsWith("/secrets")) return { status: failSecret ? 403 : 201, body: "{}" };
      if (method === "PATCH" || method === "DELETE") return { status: 200, body: "{}" };
      if (path.includes("/pods?"))
        return { status: 200, body: JSON.stringify({ items: [{ metadata: { name: "p" } }] }) };
      if (path.includes("/log")) return { status: 200, body: `[stardust-image-digest] ${DIGEST}\n` };
      return { status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) };
    },
    stream: () => Promise.reject(new Error("no stream")),
  };
  return { kube, calls };
}
const options = {
  namespace: "builds",
  registry: "registry.example.com",
  pushSecret: "push",
  cloneSecret: "static-clone",
};
type JobBody = {
  metadata: { name: string };
  spec: {
    suspend?: boolean;
    template: {
      spec: {
        initContainers: Array<{ env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string } } }> }>;
        containers: Array<{ env: Array<{ name: string }> }>;
      };
    };
  };
};

it("makes the Job suspended, gives it a Secret it owns, then releases it; the build container never sees the token", async () => {
  const { kube, calls } = fakeKube();
  const out = await createBuilder({ ...options, kube }).build(request, {
    signal: new AbortController().signal,
    pollMs: 1,
  });
  assert.equal(out.result, "success");
  const job = calls.find((c) => c.method === "POST" && c.path.endsWith("/jobs"))?.body as JobBody;
  assert.equal(job.spec.suspend, true);
  const secret = calls.find((c) => c.path.endsWith("/secrets"))?.body as {
    metadata: { name: string; ownerReferences: Array<{ kind: string; name: string; uid: string }> };
    stringData: { token: string };
  };
  assert.equal(secret.metadata.name, `${job.metadata.name}-clone`);
  assert.deepEqual(secret.metadata.ownerReferences[0], {
    apiVersion: "batch/v1",
    kind: "Job",
    name: job.metadata.name,
    uid: "job-uid-1",
  });
  assert.equal(secret.stringData.token, "ghs_one-repo");
  const order = calls.map((c) => `${c.method} ${c.path.split("/").at(-1)}`);
  assert.ok(
    order.indexOf("POST secrets") < order.findIndex((o) => o.startsWith("PATCH")),
    "the Secret exists before the Job runs",
  );
  assert.deepEqual(calls.find((c) => c.method === "PATCH")?.body, { spec: { suspend: false } });
  const clone = job.spec.template.spec.initContainers[0]?.env.find((e) => e.name === "GITHUB_TOKEN");
  assert.equal(clone?.valueFrom?.secretKeyRef?.name, `${job.metadata.name}-clone`, "not the static clone secret");
  assert.ok(
    !job.spec.template.spec.containers[0]?.env.some((e) => e.name === "GITHUB_TOKEN"),
    "the build step has no token",
  );
  assert.ok(!JSON.stringify(job).includes("ghs_one-repo"), "the token is not in the Job");
});

it("deletes the Job when its Secret cannot be made", async () => {
  const { kube, calls } = fakeKube(true);
  await assert.rejects(
    createBuilder({ ...options, kube }).build(request, { signal: new AbortController().signal, pollMs: 1 }),
    /Secret could not be made: 403/,
  );
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path.includes("/jobs/")));
  assert.ok(!calls.some((c) => c.method === "PATCH"), "never released");
});
