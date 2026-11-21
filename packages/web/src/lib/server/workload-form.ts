/**
 * The workload settings a component's form asks for, as the runtime
 * plugin's `PUT …/workload` takes them. Every field the form shows is sent,
 * so saving the section sets them all; a probe written by hand in another
 * form (exec, TCP) is left alone while its fields stay empty. The server
 * checks every value again.
 */

export interface WorkloadForm {
  serviceAccount: boolean;
  probes: Partial<Record<"startup" | "readiness" | "liveness", { path: string; port: number } | null>>;
  readOnlyRootFilesystem: boolean;
  writablePaths: string[];
  runAsUser: number | null;
  runAsGroup: number | null;
  fsGroup: number | null;
  oneAtATime: boolean;
}

export class WorkloadFormError extends Error {}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function id(form: FormData, key: string): number | null {
  const v = text(form, key);
  if (v === "") return null;
  if (!/^\d+$/.test(v)) throw new WorkloadFormError(`${key} must be a number, or empty for none`);
  return Number(v);
}

export function readWorkloadForm(form: FormData): WorkloadForm {
  const probes: WorkloadForm["probes"] = {};
  for (const kind of ["startup", "readiness", "liveness"] as const) {
    const path = text(form, `probes.${kind}.path`);
    const port = text(form, `probes.${kind}.port`);
    if (path === "" && port === "") {
      // A probe set by hand in a form this page does not edit stays as it is.
      if (form.get(`probes.${kind}.other`) !== "1") probes[kind] = null;
      continue;
    }
    if (path === "" || !/^\d+$/.test(port)) {
      throw new WorkloadFormError(`The ${kind} probe needs both a path and a port, or neither.`);
    }
    probes[kind] = { path, port: Number(port) };
  }
  return {
    serviceAccount: form.get("serviceAccount") === "on",
    probes,
    readOnlyRootFilesystem: form.get("readOnlyRootFilesystem") === "on",
    writablePaths: text(form, "writablePaths")
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean),
    runAsUser: id(form, "runAsUser"),
    runAsGroup: id(form, "runAsGroup"),
    fsGroup: id(form, "fsGroup"),
    oneAtATime: form.get("oneAtATime") === "on",
  };
}
