import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DeployRequest, KubeClient } from "@stardust/core";
import { workersTarget } from "./index.ts";
import { BUILD, configName, D1_BINDINGS, DEPLOY, deployJob } from "./job.ts";

const request: DeployRequest = {
  projectId: "Pico",
  repo: "acme/pico",
  sha: "a".repeat(40),
  component: "web",
  runId: "00000000-0000-4000-8000-000000000001",
  jobName: "web",
  buildEnv: { PUBLIC_API: "https://api.example.com" },
};
const options = { namespace: "builds", tokenSecret: "cloudflare-deploy", cloneSecret: "github-clone" };

type Container = {
  name: string;
  env?: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string } } }>;
};
const pod = (job: Record<string, unknown>) =>
  (
    job as {
      spec: {
        template: {
          spec: { initContainers: Container[]; containers: Container[]; volumes: Array<Record<string, unknown>> };
        };
      };
    }
  ).spec.template.spec;
const secretsOf = (c: Container) =>
  (c.env ?? []).flatMap((e) => (e.valueFrom?.secretKeyRef ? [`${e.name}<-${e.valueFrom.secretKeyRef.name}`] : []));

describe("the release Job", () => {
  const job = deployJob(request, options);
  const spec = pod(job);
  const step = (name: string) => [...spec.initContainers, ...spec.containers].find((c) => c.name === name) as Container;

  it("keeps the Cloudflare token in the deploy step, the clone token in the clone step, and nothing in the build", () => {
    assert.deepEqual(secretsOf(step("clone")), ["GITHUB_TOKEN<-github-clone"]);
    assert.deepEqual(secretsOf(step("build")), [], "the repository's own scripts run here");
    assert.deepEqual(secretsOf(step("deploy")), [
      "CLOUDFLARE_API_TOKEN<-cloudflare-deploy",
      "CLOUDFLARE_ACCOUNT_ID<-cloudflare-deploy",
    ]);
    assert.ok(
      step("build").env?.some((e) => e.name === "PUBLIC_API"),
      "build env reaches the build",
    );
  });

  it("reads the operator's config and secrets by the component's name", () => {
    assert.equal(configName("Pico", "web"), "wrangler-pico-web");
    const volumes = JSON.stringify(spec.volumes);
    assert.match(volumes, /"configMap":\{"name":"wrangler-pico-web"/);
    assert.match(volumes, /"secretName":"wrangler-pico-web","optional":true/);
  });

  it("refuses requests that would reach the shell unchecked", () => {
    for (const bad of [
      { repo: "acme/pico; id" },
      { sha: "main" },
      { context: "../etc" },
      { buildEnv: { "A B": "x" } },
      { component: "Web App" },
    ]) {
      assert.throws(() => deployJob({ ...request, ...bad } as DeployRequest, options), JSON.stringify(bad));
    }
    assert.throws(() => deployJob(request, { ...options, wranglerVersion: "latest" }));
  });

  it("has scripts that parse, and a deploy that ignores the repository's .env and config", () => {
    for (const script of [BUILD, DEPLOY]) {
      const r = spawnSync("sh", ["-n", "-c", script], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.match(DEPLOY, /rm -f \.env \.env\.\* \.dev\.vars/);
    assert.match(DEPLOY, /deploy \$\{CONFIG\}/);
    assert.match(DEPLOY, /wrangler@\$\{WRANGLER_VERSION\}/);
  });
});

describe("D1 bindings", () => {
  it("are read from a wrangler.jsonc with comments and trailing commas", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrangler-"));
    const file = join(dir, "wrangler.jsonc");
    writeFileSync(
      file,
      `{
  // the app
  "name": "pico-web", /* "d1_databases": [{"binding": "FAKE"}] */
  "main": "src/index.ts",
  "vars": { "URL": "https://example.com/a//b" },
  "d1_databases": [
    { "binding": "DB", "database_name": "pico", "migrations_dir": "migrations" },
    { "binding": "bad name" },
    { "binding": "AUDIT", "database_name": "audit", },
  ],
}`,
    );
    const r = spawnSync("node", ["-e", D1_BINDINGS, file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), ["DB", "AUDIT"]);
  });
});

describe("a release", () => {
  const fake = (log: string, succeeded = true): KubeClient => ({
    async request(method, path) {
      if (method === "POST")
        return { status: 201, body: JSON.stringify({ metadata: { name: "wrangler-pico-web-abc" } }) };
      if (path.includes("/jobs/"))
        return { status: 200, body: JSON.stringify({ status: succeeded ? { succeeded: 1 } : { failed: 1 } }) };
      if (path.endsWith("/log?tailLines=200")) return { status: 200, body: log };
      return { status: 200, body: JSON.stringify({ items: [{ metadata: { name: "pod-1" } }] }) };
    },
  });
  const signal = new AbortController().signal;

  it("reports the Worker version it printed", async () => {
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const out = await workersTarget(fake(`[deploy] ok\n[stardust-worker-version] ${id}\n`), options).deploy(request, {
      signal,
    });
    assert.equal(out.result, "success");
    assert.equal(out.version, id);
  });

  it("counts a release without a version as failed", async () => {
    const out = await workersTarget(fake("[deploy] ok\n"), options).deploy(request, { signal });
    assert.equal(out.result, "failed");
    assert.match(out.reason ?? "", /no Worker version/);
    assert.equal((await workersTarget(fake("", false), options).deploy(request, { signal })).result, "failed");
  });
});
