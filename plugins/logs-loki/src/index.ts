/**
 * Kept pod logs from Loki: what a pod printed, after the pod is gone.
 *
 *   logs-loki:
 *     url: https://loki.example.com
 *     token: { env: LOKI_TOKEN }            # optional bearer token
 *     tenant: team-a                        # optional X-Scope-OrgID
 *     lookbackHours: 168                    # how far back to look (default a week)
 *     labels: { namespace: namespace, pod: pod, container: container }   # the collector's label names
 */
import { definePlugin, KUBE_NAME, type LogSource } from "@stardust/core";

export interface LokiOptions {
  url: string;
  token?: string;
  tenant?: string;
  lookbackHours?: number;
  labels?: { namespace?: string; pod?: string; container?: string };
  fetch?: typeof fetch;
}

const MAX_LINES = 5_000;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function lokiLogs(options: LokiOptions): LogSource {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const labels = { namespace: "namespace", pod: "pod", container: "container", ...options.labels };
  return {
    kind: "history",
    async read({ namespace, pod, container, tailLines, sinceSeconds, signal }) {
      for (const name of [namespace, pod, ...(container ? [container] : [])]) {
        if (!KUBE_NAME.test(name)) throw new Error(`not a Kubernetes name: ${JSON.stringify(name)}`);
      }
      // Values are Kubernetes names (checked above), so quoting them cannot open the selector.
      const selector = [
        `${labels.namespace}="${namespace}"`,
        `${labels.pod}="${pod}"`,
        ...(container ? [`${labels.container}="${container}"`] : []),
      ].join(",");
      const now = Date.now();
      const since = sinceSeconds ?? (options.lookbackHours ?? 168) * 3600;
      const query = new URLSearchParams({
        query: `{${selector}}`,
        start: String(BigInt(now - since * 1000) * 1_000_000n),
        end: String(BigInt(now) * 1_000_000n),
        limit: String(Math.min(Math.max(1, tailLines ?? MAX_LINES), MAX_LINES)),
        direction: "backward",
      });
      const res = await doFetch(`${base}/loki/api/v1/query_range?${query}`, {
        headers: {
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.tenant ? { "x-scope-orgid": options.tenant } : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!res.ok) throw new Error(`Loki answered ${res.status}`);
      const body = (await res.json()) as { data?: { result?: Array<{ values?: Array<[string, string]> }> } };
      const entries = (body.data?.result ?? [])
        .flatMap((s) => s.values ?? [])
        .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0));
      if (entries.length === 0) return { state: "none" };
      const kept = tailLines !== undefined ? entries.slice(-tailLines) : entries;
      const text = kept.map(([, line]) => (line.endsWith("\n") ? line : `${line}\n`)).join("");
      return {
        state: "open",
        body: (async function* () {
          yield new TextEncoder().encode(text);
        })(),
      };
    },
  };
}

const isRef = (v: unknown) =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && ("env" in v || "file" in v);

export const plugin = definePlugin({
  manifest: { name: "logs-loki", description: "Pod logs kept in Loki, after the pod is gone." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s)) {
      if (!["url", "token", "tenant", "lookbackHours", "labels"].includes(key)) problems.push(`unknown key "${key}"`);
    }
    if (typeof s.url !== "string" || !/^https?:\/\/\S+$/.test(s.url)) problems.push("url must be an http(s) URL");
    if (s.token !== undefined && !isRef(s.token))
      problems.push("token must be a reference: { env: NAME } or { file: PATH }");
    if (s.tenant !== undefined && (typeof s.tenant !== "string" || s.tenant === ""))
      problems.push("tenant must be a name");
    if (s.lookbackHours !== undefined && (!Number.isInteger(s.lookbackHours) || (s.lookbackHours as number) < 1)) {
      problems.push("lookbackHours must be a whole number of hours");
    }
    if (s.labels !== undefined) {
      if (typeof s.labels !== "object" || s.labels === null) problems.push("labels must be a mapping");
      else {
        for (const [key, value] of Object.entries(s.labels)) {
          if (!["namespace", "pod", "container"].includes(key)) problems.push(`labels: unknown key "${key}"`);
          else if (typeof value !== "string" || !LABEL.test(value))
            problems.push(`labels.${key} must be a Loki label name`);
        }
      }
    }
    return problems;
  },
  provides: {
    ports: ["logs"],
    async create({ config, resolveSecret }) {
      return {
        logs: {
          loki: lokiLogs({
            url: config.url as string,
            ...(config.token ? { token: await resolveSecret(config.token, "plugins.logs-loki.token") } : {}),
            ...(config.tenant ? { tenant: config.tenant as string } : {}),
            ...(config.lookbackHours ? { lookbackHours: config.lookbackHours as number } : {}),
            ...(config.labels ? { labels: config.labels as NonNullable<LokiOptions["labels"]> } : {}),
          }),
        },
      };
    },
  },
});
