import assert from "node:assert/strict";
import { it } from "node:test";
import { readWorkloadForm, WorkloadFormError } from "./workload-form.ts";

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

it("reads every field the section shows, empty ids and probes as none", () => {
  assert.deepEqual(
    readWorkloadForm(
      form({
        serviceAccount: "on",
        "probes.startup.path": "/healthz",
        "probes.startup.port": "8080",
        "probes.readiness.path": "",
        "probes.readiness.port": "",
        readOnlyRootFilesystem: "on",
        writablePaths: "/tmp\n /var/cache ,",
        runAsUser: "1000",
        runAsGroup: " 1000 ",
        fsGroup: "",
        oneAtATime: "on",
      }),
    ),
    {
      serviceAccount: true,
      probes: { startup: { path: "/healthz", port: 8080 }, readiness: null, liveness: null },
      readOnlyRootFilesystem: true,
      writablePaths: ["/tmp", "/var/cache"],
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: null,
      oneAtATime: true,
    },
  );
});

it("leaves a probe written by hand alone while its fields are empty", () => {
  const read = readWorkloadForm(form({ "probes.liveness.other": "1" }));
  assert.equal("liveness" in read.probes, false);
  assert.equal(read.probes.startup, null);
  assert.equal(read.serviceAccount, false);
});

it("refuses half a probe and an id that is not a number", () => {
  assert.throws(() => readWorkloadForm(form({ "probes.startup.path": "/healthz" })), WorkloadFormError);
  assert.throws(() => readWorkloadForm(form({ runAsUser: "app" })), WorkloadFormError);
});
