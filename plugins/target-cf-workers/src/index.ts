/**
 * Pipeline W: a component released as a Cloudflare Worker.
 *
 *   target-cf-workers:
 *     namespace: stardust-builds       # where the release Jobs run
 *     tokenSecret: cloudflare-deploy   # keys token and account-id
 *     cloneSecret: github-clone        # optional, for private repositories
 *     wranglerVersion: "4.156.0"       # optional
 *
 * For each W component keep, in that namespace, a ConfigMap
 * `wrangler-<project>-<component>` with `wrangler.jsonc`, and optionally a
 * Secret of the same name with `secrets.json` (for `wrangler secret bulk`).
 */
import {
  type DeployOutcome,
  type DeployRequest,
  type DeployTarget,
  definePlugin,
  isKubeName,
  type KubeClient,
  runJob,
} from "@stardust/core";
import { deployJob, VERSION_LINE, type WorkersOptions } from "./job.ts";

export { configName, DEFAULT_WRANGLER, DeployInputError, deployJob, type WorkersOptions } from "./job.ts";

export function workersTarget(kube: KubeClient, options: WorkersOptions): DeployTarget {
  return {
    async deploy(request: DeployRequest, { signal, pollMs }): Promise<DeployOutcome> {
      const run = await runJob(kube, options.namespace, deployJob(request, options), {
        signal,
        ...(pollMs !== undefined ? { pollMs } : {}),
      });
      if (run.result !== "success") return run;
      const version = VERSION_LINE.exec(run.logTail)?.[1];
      if (!version) return { ...run, result: "failed", reason: "the release succeeded but printed no Worker version" };
      return { ...run, version };
    },
  };
}

export const plugin = definePlugin({
  manifest: { name: "target-cf-workers", description: "Pipeline W: components released as Cloudflare Workers." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const known = [
      "namespace",
      "tokenSecret",
      "cloneSecret",
      "gitBaseUrl",
      "cloneUsername",
      "wranglerVersion",
      "deadlineSeconds",
    ];
    const problems = Object.keys(s)
      .filter((k) => !known.includes(k))
      .map((k) => `unknown key "${k}"`);
    if (!isKubeName(s.namespace)) problems.push("namespace must be a namespace name");
    if (!isKubeName(s.tokenSecret)) problems.push("tokenSecret must name a Secret with keys token and account-id");
    if (s.cloneSecret !== undefined && !isKubeName(s.cloneSecret)) problems.push("cloneSecret must name a Secret");
    if (
      s.gitBaseUrl !== undefined &&
      (typeof s.gitBaseUrl !== "string" || !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(s.gitBaseUrl))
    ) {
      problems.push("gitBaseUrl must be an http(s) origin");
    }
    if (
      s.wranglerVersion !== undefined &&
      (typeof s.wranglerVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(s.wranglerVersion))
    ) {
      problems.push("wranglerVersion must be an exact version, e.g. 4.156.0");
    }
    if (
      s.deadlineSeconds !== undefined &&
      (!Number.isInteger(s.deadlineSeconds) || (s.deadlineSeconds as number) < 60)
    ) {
      problems.push("deadlineSeconds must be at least 60");
    }
    return problems;
  },
  provides: {
    ports: ["deployTargets"],
    needs: ["kube"],
    async create({ config, ports }) {
      if (!ports.kube) return {};
      return { deployTargets: { W: workersTarget(ports.kube, config as unknown as WorkersOptions) } };
    },
  },
});
