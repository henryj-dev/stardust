import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import type { KubeClient } from "@stardust/core";
import { databaseProviderContract } from "@stardust/core/testing";
import { parse } from "yaml";
import { majorOf, statefulSetPostgres } from "./statefulset.ts";

const sts = (namespace: string, name: string, image: string, extra: Record<string, unknown> = {}) => ({
  metadata: { namespace, name },
  spec: {
    replicas: 1,
    serviceName: name,
    template: {
      spec: {
        containers: [
          {
            image,
            env: [{ name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: `${name}-pw`, key: "pw" } } }],
          },
        ],
      },
    },
  },
  status: { readyReplicas: 1 },
  ...extra,
});

function fakeKube(byNamespace: Record<string, unknown[]>, log: string[] = []): KubeClient {
  return {
    async request(method, path) {
      log.push(`${method} ${path}`);
      const list = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/statefulsets$/.exec(path);
      if (list) return { status: 200, body: JSON.stringify({ items: byNamespace[list[1] ?? ""] ?? [] }) };
      const one = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/statefulsets\/([^/]+)$/.exec(path);
      const found =
        one &&
        (byNamespace[one[1] ?? ""] ?? []).find((o) => (o as { metadata: { name: string } }).metadata.name === one[2]);
      return found ? { status: 200, body: JSON.stringify(found) } : { status: 404, body: "{}" };
    },
  };
}

databaseProviderContract("statefulset", async () =>
  statefulSetPostgres({ kube: fakeKube({}), namespace: "databases", namespaces: [] }),
);

describe("finding instances", () => {
  const kube = fakeKube({
    databases: [sts("databases", "orders", "postgres:17-alpine")],
    apps: [
      sts("apps", "legacy", "docker.io/library/postgres:16.4@sha256:abc"),
      sts("apps", "cache", "redis:7"),
      { ...sts("apps", "starting", "postgis/postgis:16-3.4"), status: {} },
    ],
    elsewhere: [sts("elsewhere", "hidden", "postgres:17")],
  });
  const p = statefulSetPostgres({ kube, namespace: "databases", namespaces: ["apps"] });

  it("finds PostgreSQL by its image in the namespaces it is given, with the superuser Secret by name", async () => {
    const found = await p.discover();
    assert.deepEqual(
      found.map((s) => [`${s.ref.namespace}/${s.ref.name}`, s.version, s.ready]),
      [
        ["apps/legacy", "16", true],
        ["apps/starting", "16", false],
        ["databases/orders", "17", true],
      ],
    );
    assert.deepEqual(found[0]?.superuser, { name: "legacy-pw", key: "pw" });
    assert.equal(found[0]?.service, "legacy");
  });

  it("observes one, and does not look outside its namespaces", async () => {
    assert.equal((await p.observe({ namespace: "databases", name: "orders" }))?.ready, true);
    assert.equal(await p.observe({ namespace: "databases", name: "gone" }), null);
    assert.equal(await p.observe({ namespace: "elsewhere", name: "hidden" }), null);
  });

  it("reads major versions from tags", () => {
    assert.equal(majorOf("postgres:17-alpine"), "17");
    assert.equal(majorOf("registry:5000/postgres"), null);
    assert.equal(majorOf("postgres@sha256:abc"), null);
  });
});

describe("the rendered scripts", () => {
  const p = statefulSetPostgres({ kube: fakeKube({}), namespace: "databases", namespaces: [] });
  const scriptOf = (files: Record<string, string>) => {
    const o = parse(Object.values(files)[0] ?? "") as { kind: string; spec: Record<string, never> };
    type Pod = { containers: Array<{ command: string[] }> };
    const spec = o.spec as unknown as { template: { spec: Pod }; jobTemplate: { spec: { template: { spec: Pod } } } };
    const pod = o.kind === "CronJob" ? spec.jobTemplate.spec.template.spec : spec.template.spec;
    return pod.containers[0]?.command[2] ?? "";
  };
  const target = {
    name: "orders",
    ref: { namespace: "databases", name: "orders" },
    host: "orders.databases.svc",
    superuser: { name: "orders-superuser", key: "password" },
  };

  it("parse as shell", () => {
    const grant = scriptOf(
      p.renderAppGrant(target, { database: "orders", role: "orders_app", password: { name: "pw", key: "password" } }),
    );
    const backup = scriptOf(
      p.renderBackup({
        name: "db-backup",
        namespace: "databases",
        schedule: "15 3 * * *",
        storage: { endpoint: "https://s3.example.com", bucket: "backups", credentials: "backup-s3", prefix: "pg" },
        recipient: `age1${"q".repeat(58)}`,
        retentionHours: 168,
        targets: [
          target,
          {
            ...target,
            name: "billing",
            ref: { namespace: "databases", name: "billing" },
            host: "billing.databases.svc",
          },
        ],
      }),
    );
    const check = scriptOf(
      p.renderRestoreCheck({
        name: "check",
        namespace: "databases",
        storage: { endpoint: "https://s3.example.com", bucket: "backups", credentials: "backup-s3", prefix: "pg" },
        source: "orders",
        identity: { name: "age", key: "identity" },
      }),
    );
    for (const script of [grant, backup, check]) {
      const r = spawnSync("sh", ["-n", "-c", script], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(backup.match(/^dump_one /gm)?.length, 2, "one dump per target");
    assert.match(backup, /\[ "\$UPLOADED" -eq 2 \]/);
  });
});
