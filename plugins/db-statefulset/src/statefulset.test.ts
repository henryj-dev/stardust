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

describe("the superuser's role", () => {
  const PASSWORD = { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "pw", key: "pw" } } };
  const withEnv = (name: string, env: unknown[], envFrom?: unknown[]) => {
    const o = sts("apps", name, "postgres:17-alpine");
    const c = o.spec.template.spec.containers[0] as Record<string, unknown>;
    c.env = env;
    if (envFrom) c.envFrom = envFrom;
    return o;
  };
  const kube = fakeKube({
    apps: [
      withEnv("plain", [PASSWORD]),
      withEnv("named", [{ name: "POSTGRES_USER", value: "analytics" }, PASSWORD]),
      withEnv("explicit", [{ name: "POSTGRES_USER", value: "postgres" }, PASSWORD]),
      withEnv("empty", [{ name: "POSTGRES_USER" }, PASSWORD]),
      withEnv("secret", [{ name: "POSTGRES_USER", valueFrom: { secretKeyRef: { name: "u", key: "u" } } }, PASSWORD]),
      withEnv("quoted", [{ name: "POSTGRES_USER", value: "Hub-Admin" }, PASSWORD]),
      withEnv("envfrom", [PASSWORD], [{ configMapRef: { name: "pg-env" } }]),
      withEnv(
        "envfrom-named",
        [{ name: "POSTGRES_USER", value: "sso_admin" }, PASSWORD],
        [{ configMapRef: { name: "x" } }],
      ),
    ],
  });
  const p = statefulSetPostgres({ kube, namespace: "apps", namespaces: [] });

  it("is POSTGRES_USER when the pod sets it plainly, postgres when it does not, unknown otherwise", async () => {
    const found = Object.fromEntries((await p.discover()).map((s) => [s.ref.name, s.superuser]));
    assert.deepEqual(found, {
      plain: { name: "pw", key: "pw" },
      named: { name: "pw", key: "pw", role: "analytics" },
      explicit: { name: "pw", key: "pw" },
      empty: { name: "pw", key: "pw" },
      // From a Secret, behind envFrom, or not a plain identifier: no one known to sign in as.
      secret: null,
      quoted: null,
      envfrom: null,
      "envfrom-named": { name: "pw", key: "pw", role: "sso_admin" },
    });
  });

  it("goes into the dump, the fingerprint and the grant as env, never into the script", () => {
    const target = {
      name: "goat",
      ref: { namespace: "apps", name: "named" },
      host: "named.apps.svc",
      superuser: { name: "pw", key: "pw", role: "analytics" },
    };
    const plain = { ...target, name: "plain", host: "plain.apps.svc", superuser: { name: "pw", key: "pw" } };
    const backup = parse(
      Object.values(
        p.renderBackup({
          name: "db-backup",
          namespace: "apps",
          schedule: "15 3 * * *",
          storage: { endpoint: "https://s3.example.com", bucket: "backups", credentials: "c", prefix: "pg" },
          recipient: `age1${"q".repeat(58)}`,
          retentionHours: 24,
          targets: [target, plain],
        }),
      )[0] ?? "",
    ) as { spec: { jobTemplate: { spec: { template: { spec: PodSpec } } } } };
    const dump = backup.spec.jobTemplate.spec.template.spec.initContainers?.[0] as Container & {
      env: Array<{ name: string; value?: string }>;
    };
    assert.deepEqual(
      dump.env.filter((e) => e.name.startsWith("ROLE_")),
      [
        { name: "ROLE_0", value: "analytics" },
        { name: "ROLE_1", value: "postgres" },
      ],
    );
    const script = dump.command?.[2] ?? "";
    assert.ok(!script.includes("analytics") && !/-U postgres/.test(script));
    assert.match(script, /^dump_one goat named\.apps\.svc "\$PW_0" "\$ROLE_0"$/m);
    assert.match(script, /fingerprint "\$HOST" "\$ROLE"/);
    assert.match(script, /pg_dumpall --clean --if-exists -h "\$HOST" -U "\$ROLE"/);

    const job = parse(
      Object.values(
        p.renderAppGrant(target, { database: "stats", role: "stats_app", password: { name: "a", key: "p" } }),
      )[0] ?? "",
    ) as { spec: { template: { spec: PodSpec } } };
    const grant = job.spec.template.spec.containers[0] as Container & { env: Array<{ name: string; value?: string }> };
    assert.deepEqual(
      grant.env.find((e) => e.name === "PGUSER"),
      { name: "PGUSER", value: "analytics" },
    );
    assert.ok(!(grant.command?.[2] ?? "").includes("-U postgres"));
    assert.throws(
      () => p.renderAppGrant(target, { database: "x", role: "analytics", password: { name: "a", key: "p" } }),
      /must not be the superuser/,
    );
    assert.throws(
      () =>
        p.renderAppGrant(
          { ...target, superuser: { name: "pw", key: "pw", role: "a b" } },
          { database: "x", role: "x_app", password: { name: "a", key: "p" } },
        ),
      /superuser role/,
    );
  });
});

type Container = {
  name: string;
  image: string;
  command?: string[];
  securityContext?: { allowPrivilegeEscalation?: boolean; capabilities?: { drop?: string[]; add?: string[] } };
};
type PodSpec = {
  securityContext?: Record<string, unknown>;
  initContainers?: Container[];
  containers: Container[];
  volumes?: Array<Record<string, unknown>>;
};

/** The pod template of a StatefulSet, Job or CronJob, or null. */
function podOf(o: { kind: string; spec?: Record<string, never> }): PodSpec | null {
  const spec = o.spec as unknown as {
    template?: { spec: PodSpec };
    jobTemplate?: { spec: { template: { spec: PodSpec } } };
  };
  if (o.kind === "CronJob") return spec.jobTemplate?.spec.template.spec ?? null;
  if (o.kind === "StatefulSet" || o.kind === "Job") return spec.template?.spec ?? null;
  return null;
}
const docsOf = (files: Record<string, string>) =>
  Object.values(files).map(
    (f) => parse(f) as { kind: string; metadata: { name: string }; spec?: Record<string, never> },
  );

/** Why a pod would not pass Pod Security Admission "restricted" as rendered here, or nothing. */
function restrictedProblems(pod: PodSpec): string[] {
  const problems: string[] = [];
  const sc = pod.securityContext ?? {};
  if (sc.runAsNonRoot !== true) problems.push("pod: runAsNonRoot is not true");
  for (const k of ["runAsUser", "runAsGroup", "fsGroup"]) if (sc[k] !== 70) problems.push(`pod: ${k} is not 70`);
  if ((sc.seccompProfile as { type?: string } | undefined)?.type !== "RuntimeDefault")
    problems.push("pod: seccompProfile is not RuntimeDefault");
  for (const k of ["hostNetwork", "hostPID", "hostIPC"])
    if ((pod as Record<string, unknown>)[k]) problems.push(`pod: ${k}`);
  const allowed = [
    "configMap",
    "csi",
    "downwardAPI",
    "emptyDir",
    "ephemeral",
    "persistentVolumeClaim",
    "projected",
    "secret",
  ];
  for (const v of pod.volumes ?? [])
    for (const k of Object.keys(v))
      if (k !== "name" && !allowed.includes(k)) problems.push(`volume ${String(v.name)}: ${k} is not allowed`);
  for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
    const csc = c.securityContext ?? {};
    if (csc.allowPrivilegeEscalation !== false) problems.push(`${c.name}: allowPrivilegeEscalation is not false`);
    if (!csc.capabilities?.drop?.includes("ALL")) problems.push(`${c.name}: capabilities do not drop ALL`);
    if ((csc.capabilities?.add ?? []).some((a) => a !== "NET_BIND_SERVICE"))
      problems.push(`${c.name}: adds capabilities`);
    for (const k of ["privileged", "runAsUser", "runAsNonRoot"] as const) {
      const v = (csc as Record<string, unknown>)[k];
      if (k === "privileged" ? v === true : k === "runAsUser" ? v === 0 : v === false)
        problems.push(`${c.name}: overrides ${k}`);
    }
    // Nothing installed at run time: each step brings its tools in its image.
    if (/\b(apk|apt-get|yum|dnf|pip)\b/.test((c.command ?? []).join(" ")))
      problems.push(`${c.name}: installs packages`);
  }
  return problems;
}

describe("the rendered workloads", () => {
  const p = statefulSetPostgres({ kube: fakeKube({}), namespace: "databases", namespaces: [] });
  const target = {
    name: "orders",
    ref: { namespace: "databases", name: "orders" },
    host: "orders.databases.svc",
    superuser: { name: "orders-superuser", key: "password" },
  };
  const storage = { endpoint: "https://s3.example.com", bucket: "backups", credentials: "backup-s3", prefix: "pg" };
  const rendered = {
    instance: p.renderInstance({
      name: "orders",
      version: "17",
      storage: "10Gi",
      cpu: "250m",
      memory: "512Mi",
    }),
    grant: p.renderAppGrant(target, {
      database: "orders",
      role: "orders_app",
      password: { name: "pw", key: "password" },
    }),
    backup: p.renderBackup({
      name: "db-backup",
      namespace: "databases",
      schedule: "15 3 * * *",
      storage,
      recipient: `age1${"q".repeat(58)}`,
      retentionHours: 168,
      targets: [
        target,
        { ...target, name: "billing", ref: { namespace: "databases", name: "billing" }, host: "billing.databases.svc" },
      ],
    }),
    check: p.renderRestoreCheck({
      name: "check",
      namespace: "databases",
      storage,
      source: "orders",
      identity: { name: "age", key: "identity" },
    }),
  };
  const podsOf = (files: Record<string, string>) =>
    docsOf(files).flatMap((d) => {
      const pod = podOf(d);
      return pod ? [pod] : [];
    });
  const stepsOf = (files: Record<string, string>) =>
    podsOf(files).flatMap((pod) => [...(pod.initContainers ?? []), ...pod.containers]);
  const scriptOf = (files: Record<string, string>, name: string) =>
    stepsOf(files).find((c) => c.name === name)?.command?.[2] ?? "";

  it("pass Pod Security Admission restricted, every pod and container", () => {
    const kinds: string[] = [];
    for (const [what, files] of Object.entries(rendered)) {
      for (const d of docsOf(files)) {
        const pod = podOf(d);
        if (!pod) continue;
        kinds.push(d.kind);
        assert.deepEqual(restrictedProblems(pod), [], `${what}: ${d.kind} ${d.metadata.name}`);
      }
    }
    assert.deepEqual(kinds.sort(), ["CronJob", "Job", "Job", "StatefulSet"]);
    // The checker itself catches what the cluster would reject.
    const bad = restrictedProblems({ containers: [{ name: "x", image: "y", command: ["sh", "-c", "apk add age"] }] });
    assert.ok(bad.some((b) => /seccompProfile/.test(b)) && bad.some((b) => /installs/.test(b)) && bad.length >= 7);
  });

  it("run each backup and restore step in one image pinned by digest, sharing /work", () => {
    const steps = (files: Record<string, string>) => stepsOf(files).map((c) => [c.name, c.image.split(/[:@]/)[0]]);
    assert.deepEqual(steps(rendered.backup), [
      ["dump", "postgres"],
      ["encrypt", "ghcr.io/getsops/sops"],
      ["upload", "docker.io/amazon/aws-cli"],
    ]);
    assert.deepEqual(steps(rendered.check), [
      ["fetch", "docker.io/amazon/aws-cli"],
      ["decrypt", "ghcr.io/getsops/sops"],
      ["restore-check", "postgres"],
    ]);
    for (const c of [...stepsOf(rendered.backup), ...stepsOf(rendered.check)]) {
      if (!c.image.startsWith("postgres:")) assert.match(c.image, /@sha256:[0-9a-f]{64}$/, c.name);
      assert.ok(
        (c as { volumeMounts?: Array<{ mountPath: string }> }).volumeMounts?.some((m) => m.mountPath === "/work"),
        c.name,
      );
    }
    const identity = stepsOf(rendered.check).filter((c) =>
      (c as { volumeMounts?: Array<{ name: string }> }).volumeMounts?.some((m) => m.name === "identity"),
    );
    assert.deepEqual(
      identity.map((c) => c.name),
      ["decrypt"],
      "only the decrypt step sees the identity",
    );
  });

  it("parse as shell, and cover every target once", () => {
    const scripts = [rendered.grant, rendered.backup, rendered.check].flatMap((f) =>
      stepsOf(f).map((c) => c.command?.[2] ?? ""),
    );
    assert.equal(scripts.length, 7);
    for (const script of scripts) {
      const r = spawnSync("sh", ["-n", "-c", script], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(scriptOf(rendered.backup, "dump").match(/^dump_one /gm)?.length, 2, "one dump per target");
    assert.match(scriptOf(rendered.backup, "dump"), /\[ "\$DUMPED" -eq 2 \]/);
    assert.equal(scriptOf(rendered.backup, "encrypt").match(/^encrypt_one /gm)?.length, 2);
    assert.match(scriptOf(rendered.backup, "encrypt"), /\[ "\$ENCRYPTED" -eq 2 \]/);
    assert.equal(scriptOf(rendered.backup, "upload").match(/^upload_one /gm)?.length, 2);
    assert.match(scriptOf(rendered.backup, "upload"), /\[ "\$UPLOADED" -eq 2 \]/);
    assert.match(scriptOf(rendered.backup, "upload"), /put "\$BASE\.sql\.gz\.sops\.json"/);
    assert.match(scriptOf(rendered.check, "fetch"), /\\\.sql\\\.gz\\\.sops\\\.json\$/);
  });
});
