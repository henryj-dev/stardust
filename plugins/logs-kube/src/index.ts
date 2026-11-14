/**
 * Live pod logs from the Kubernetes API: what a running pod (or one that has
 * just stopped) printed, followed while it prints. Nothing is kept: when the
 * pod is gone, so is this log.
 *
 *   logs-kube: {}
 */
import { definePlugin, KUBE_NAME, type KubeStreamClient, type LogSource } from "@stardust/core";

const LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_TAIL = 10_000;

export function kubeLogs(kube: KubeStreamClient): LogSource {
  return {
    kind: "live",
    async read({ namespace, pod, container, follow, tailLines, sinceSeconds, signal }) {
      for (const name of [namespace, pod, ...(container ? [container] : [])]) {
        if (!KUBE_NAME.test(name)) throw new Error(`not a Kubernetes name: ${JSON.stringify(name)}`);
      }
      const query = new URLSearchParams({ limitBytes: String(LIMIT_BYTES) });
      if (container) query.set("container", container);
      if (follow) query.set("follow", "true");
      if (tailLines !== undefined) query.set("tailLines", String(Math.min(Math.max(1, tailLines), MAX_TAIL)));
      if (sinceSeconds !== undefined) query.set("sinceSeconds", String(Math.max(1, Math.floor(sinceSeconds))));
      const res = await kube.stream(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${query}`,
        signal,
      );
      if (res.status === 404) return { state: "none" };
      if (res.status < 200 || res.status >= 300) throw new Error(`kubernetes API returned ${res.status} for a pod log`);
      return { state: "open", body: res.body };
    },
  };
}

export const plugin = definePlugin({
  manifest: { name: "logs-kube", description: "Live pod logs from the Kubernetes API." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    return Object.keys(section).map((key) => `unknown key "${key}"`);
  },
  provides: {
    ports: ["logs"],
    needs: ["kube"],
    async create({ ports }) {
      return ports.kube ? { logs: { kube: kubeLogs(ports.kube) } } : {};
    },
  },
});
