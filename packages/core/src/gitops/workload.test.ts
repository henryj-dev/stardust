import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse, parseAllDocuments } from "yaml";
import { WorkloadEditError } from "../runtime/workloads.ts";
import { listResources } from "./kustomization.ts";
import { restrictedProblems } from "./pod-security.ts";
import { scaffoldComponent } from "./scaffold.ts";
import {
  checkWorkloadChange,
  planWorkload,
  readDirectoryWorkload,
  readWorkloadSettings,
  SERVICE_ACCOUNT_FILE,
  setWorkloadSettings,
  type WorkloadChange,
  writableVolumeName,
} from "./workload.ts";

const DIR = "deploy/demo/server";
const scaffolded = () =>
  new Map(
    [
      ...scaffoldComponent({
        project: "demo",
        component: "server",
        namespace: "demo",
        imageRepository: "registry.example.com/demo/server",
        port: 8080,
      }),
    ].map(([k, v]) => [`${DIR}/${k}`, v]),
  );

/** The settings of the first app: its own account and token, probes, a read-only root, ids, one pod at a time. */
const SERVER: WorkloadChange = {
  serviceAccount: true,
  probes: {
    startup: { path: "/healthz", port: 8080 },
    readiness: { path: "/readyz", port: 8080 },
    liveness: { path: "/healthz", port: 8080 },
  },
  readOnlyRootFilesystem: true,
  writablePaths: ["/tmp"],
  runAsUser: 1000,
  runAsGroup: 1000,
  fsGroup: 1000,
  oneAtATime: true,
};

const apply = (files: Map<string, string>, change: WorkloadChange) => {
  const out = new Map(files);
  for (const [p, t] of planWorkload(files, { dir: DIR, component: "server", change })) {
    if (t === null) out.delete(p);
    else out.set(p, t);
  }
  return out;
};

const podOf = (text: string) => parseAllDocuments(text)[0]?.toJS().spec.template.spec;

describe("workload settings", () => {
  it("checks what is asked for, naming the field", () => {
    assert.deepEqual(checkWorkloadChange(SERVER), SERVER);
    const refused = (input: unknown, re: RegExp) =>
      assert.throws(
        () => checkWorkloadChange(input),
        (e: Error) => e instanceof WorkloadEditError && re.test(e.message),
      );
    refused({ runAsUser: 0 }, /runAsUser must be a user id from 1/);
    refused({ runAsUser: "1000" }, /runAsUser/);
    refused({ fsGroup: -1 }, /fsGroup/);
    refused({ probes: { startup: { path: "healthz", port: 8080 } } }, /probes.startup.path/);
    refused({ probes: { startup: { path: "/healthz", port: 0 } } }, /probes.startup.port/);
    refused({ probes: { startup: { path: "/h", port: 1, exec: ["x"] } } }, /must be null or/);
    refused({ probes: { warmup: null } }, /unknown probe warmup/);
    refused({ writablePaths: ["/tmp", "/tmp"] }, /listed twice/);
    refused({ writablePaths: ["/var/../etc"] }, /plain absolute path/);
    refused({ writablePaths: ["/"] }, /plain absolute path/);
    refused({ oneAtATime: "yes" }, /oneAtATime must be true or false/);
    refused({ strategy: "Recreate" }, /unknown field strategy/);
  });

  it("gives a scaffolded Deployment the first app's settings, and the result meets restricted Pod Security", () => {
    const files = apply(scaffolded(), SERVER);
    const deployment = files.get(`${DIR}/deployment.yaml`) ?? "";
    assert.deepEqual(restrictedProblems(deployment), []);
    const pod = podOf(deployment);
    assert.equal(pod.serviceAccountName, "server");
    assert.equal(pod.automountServiceAccountToken, true);
    assert.deepEqual(pod.securityContext, {
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    });
    const [c] = pod.containers;
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(c.startupProbe, {
      httpGet: { path: "/healthz", port: 8080 },
      periodSeconds: 10,
      failureThreshold: 30,
    });
    assert.deepEqual(c.readinessProbe.httpGet, { path: "/readyz", port: 8080 });
    assert.deepEqual(c.volumeMounts, [{ name: "stardust-writable-tmp", mountPath: "/tmp" }]);
    assert.deepEqual(pod.volumes, [{ name: "stardust-writable-tmp", emptyDir: {} }]);
    const strategy = parse(deployment).spec.strategy;
    assert.deepEqual(strategy, { type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } });
    assert.notEqual(strategy.type, "Recreate", "never Recreate: a live RollingUpdate Deployment refuses it");

    const sa = files.get(`${DIR}/${SERVICE_ACCOUNT_FILE}`) ?? "";
    assert.deepEqual(parse(sa), {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "server", namespace: "demo" },
    });
    assert.ok(listResources(files.get(`${DIR}/kustomization.yaml`) ?? "").includes(SERVICE_ACCOUNT_FILE));

    const view = readDirectoryWorkload(files, "server");
    assert.equal(view.workloads, 1);
    assert.deepEqual(
      { ...view.settings, tokenMounted: undefined, otherProbes: undefined, recreate: undefined },
      {
        ...SERVER,
        probes: {
          startup: { path: "/healthz", port: 8080, periodSeconds: 10, failureThreshold: 30 },
          readiness: { path: "/readyz", port: 8080, periodSeconds: 10, failureThreshold: 3 },
          liveness: { path: "/healthz", port: 8080, periodSeconds: 10, failureThreshold: 3 },
        },
        tokenMounted: undefined,
        otherProbes: undefined,
        recreate: undefined,
      },
    );
    assert.equal(
      planWorkload(files, { dir: DIR, component: "server", change: SERVER }).size,
      0,
      "saving again changes nothing",
    );
  });

  it("turns the service account off: no token, the file and its list entry gone", () => {
    const on = apply(scaffolded(), { serviceAccount: true });
    const off = apply(on, { serviceAccount: false });
    assert.equal(off.has(`${DIR}/${SERVICE_ACCOUNT_FILE}`), false);
    assert.equal(listResources(off.get(`${DIR}/kustomization.yaml`) ?? "").includes(SERVICE_ACCOUNT_FILE), false);
    const pod = podOf(off.get(`${DIR}/deployment.yaml`) ?? "");
    assert.equal(pod.serviceAccountName, undefined);
    assert.equal(pod.automountServiceAccountToken, false);
    const view = readWorkloadSettings(off.get(`${DIR}/deployment.yaml`) ?? "", "server");
    assert.equal(view?.serviceAccount, false);
    assert.equal(view?.tokenMounted, false);
  });

  it("uses a service account declared by hand under the component's name instead of writing one", () => {
    const files = scaffolded();
    files.set(
      `${DIR}/rbac.yaml`,
      "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: server\n  namespace: demo\n",
    );
    const out = apply(files, { serviceAccount: true });
    assert.equal(out.has(`${DIR}/${SERVICE_ACCOUNT_FILE}`), false);
    assert.equal(podOf(out.get(`${DIR}/deployment.yaml`) ?? "").serviceAccountName, "server");
  });

  it("leaves what it does not manage: other volumes, comments, a probe written by hand", () => {
    const text = `# kept
apiVersion: apps/v1
kind: Deployment
metadata:
  name: server
  namespace: demo
spec:
  template:
    spec:
      containers:
        - name: server
          image: registry.example.com/demo/server:1
          livenessProbe:
            exec: { command: [true] }
          volumeMounts:
            - name: cache
              mountPath: /cache
      volumes:
        - name: cache
          emptyDir: {}
`;
    const view = readWorkloadSettings(text, "server");
    assert.deepEqual(view?.otherProbes, ["liveness"]);
    const out = setWorkloadSettings(text, {
      component: "server",
      change: { writablePaths: ["/tmp"], probes: { readiness: { path: "/readyz", port: 8080 } } },
    });
    assert.ok(out.text.startsWith("# kept"), out.text);
    const pod = podOf(out.text);
    assert.deepEqual(pod.containers[0].livenessProbe, { exec: { command: [true] } });
    assert.deepEqual(
      pod.volumes.map((v: { name: string }) => v.name),
      ["cache", "stardust-writable-tmp"],
    );
    assert.throws(
      () => setWorkloadSettings(text, { component: "server", change: { writablePaths: ["/cache"] } }),
      /\/cache is already a mount of another volume/,
    );
    const cleared = setWorkloadSettings(out.text, { component: "server", change: { writablePaths: [] } });
    assert.deepEqual(
      podOf(cleared.text).volumes.map((v: { name: string }) => v.name),
      ["cache"],
    );
  });

  it("never writes Recreate, keeps one set by hand, and keeps one pod at a time while a claim is mounted", () => {
    const recreate = `apiVersion: apps/v1
kind: Deployment
metadata: { name: server, namespace: demo }
spec:
  strategy: { type: Recreate }
  template:
    spec:
      containers: [{ name: server, image: x }]
`;
    assert.equal(readWorkloadSettings(recreate, "server")?.recreate, true);
    assert.equal(setWorkloadSettings(recreate, { component: "server", change: { oneAtATime: true } }).changed, false);
    assert.equal(setWorkloadSettings(recreate, { component: "server", change: { oneAtATime: false } }).changed, false);

    const claim = `apiVersion: apps/v1
kind: Deployment
metadata: { name: server, namespace: demo }
spec:
  strategy: { type: RollingUpdate, rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } }
  template:
    spec:
      containers: [{ name: server, image: x }]
      volumes: [{ name: storage-data, persistentVolumeClaim: { claimName: server-data } }]
`;
    assert.throws(
      () => setWorkloadSettings(claim, { component: "server", change: { oneAtATime: false } }),
      /mounts a claim/,
    );
    const free = setWorkloadSettings(claim.replace(/\n {6}volumes.*\n/, "\n"), {
      component: "server",
      change: { oneAtATime: false },
    });
    assert.equal(parse(free.text).spec.strategy, undefined);
  });

  it("removes the ids and probes set to null", () => {
    const files = apply(scaffolded(), SERVER);
    const out = apply(files, {
      runAsUser: null,
      runAsGroup: null,
      fsGroup: null,
      probes: { startup: null },
      readOnlyRootFilesystem: false,
    });
    const pod = podOf(out.get(`${DIR}/deployment.yaml`) ?? "");
    assert.deepEqual(pod.securityContext, { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } });
    assert.equal(pod.containers[0].startupProbe, undefined);
    assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, undefined);
    assert.ok(pod.containers[0].readinessProbe, "a probe not named is left");
  });

  it("refuses a directory without a workload, or without a kustomization to list the account in", () => {
    assert.throws(
      () =>
        planWorkload(new Map([[`${DIR}/x.yaml`, "kind: ConfigMap\n"]]), { dir: DIR, component: "server", change: {} }),
      /has no Deployment/,
    );
    const files = scaffolded();
    files.delete(`${DIR}/kustomization.yaml`);
    files.set(`${DIR}/deployment.yaml`, files.get(`${DIR}/deployment.yaml`) ?? "");
    assert.throws(
      () => planWorkload(files, { dir: DIR, component: "server", change: { serviceAccount: true } }),
      /no kustomization.yaml/,
    );
  });

  it("names writable volumes after their path, unique and within 63 characters", () => {
    assert.equal(writableVolumeName("/tmp"), "stardust-writable-tmp");
    assert.equal(writableVolumeName("/var/cache/nginx"), "stardust-writable-var-cache-nginx");
    const long = writableVolumeName(`/${"a".repeat(80)}`);
    assert.ok(long.length <= 63 && /^[a-z0-9-]+$/.test(long), long);
    const taken = new Set(["stardust-writable-a-b"]);
    assert.notEqual(writableVolumeName("/a/b", taken), "stardust-writable-a-b");
  });
});

describe("restricted Pod Security", () => {
  it("passes the scaffolded Deployment and catches each thing the standard refuses", () => {
    const base = scaffolded().get(`${DIR}/deployment.yaml`) ?? "";
    assert.deepEqual(restrictedProblems(base), []);
    const broken = (from: string, to: string, re: RegExp) => {
      assert.ok(base.includes(from), from);
      const problems = restrictedProblems(base.replace(from, to));
      assert.ok(
        problems.some((p) => re.test(p)),
        `${to}: ${problems.join("; ")}`,
      );
    };
    broken("runAsNonRoot: true", "runAsNonRoot: false", /runAsNonRoot/);
    broken("allowPrivilegeEscalation: false", "allowPrivilegeEscalation: true", /allowPrivilegeEscalation/);
    broken("drop: [ALL]", "drop: [NET_RAW]", /drop ALL/);
    broken("seccompProfile: { type: RuntimeDefault }", "seccompProfile: { type: Unconfined }", /seccompProfile/);
    broken(
      "allowPrivilegeEscalation: false",
      "allowPrivilegeEscalation: false\n            privileged: true",
      /privileged/,
    );
    broken("runAsNonRoot: true", "runAsNonRoot: true\n        runAsUser: 0", /user 0/);
    broken(
      "    spec:\n      securityContext:",
      "    spec:\n      hostNetwork: true\n      securityContext:",
      /hostNetwork/,
    );
    broken(
      "    spec:\n      securityContext:",
      "    spec:\n      volumes: [{ name: h, hostPath: { path: /etc } }]\n      securityContext:",
      /hostPath volume/,
    );
  });
});
