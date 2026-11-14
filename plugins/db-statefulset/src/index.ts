/**
 * The `databases` port for PostgreSQL run as a plain StatefulSet.
 *
 *   db-statefulset:
 *     namespace: stardust-databases      # where new instances go
 *     namespaces: [apps, tools]          # optional: where else to find instances to adopt
 *     image: postgres                    # optional: the repository; tags are <version>-alpine
 *     versions: ["16", "17"]             # optional
 *
 * It needs get/list on statefulsets in those namespaces (the chart's
 * `databases.namespaces`).
 */
import { definePlugin, isKubeName } from "@stardust/core";
import { statefulSetPostgres } from "./statefulset.ts";

export { majorOf, type StatefulSetOptions, statefulSetPostgres } from "./statefulset.ts";

export const plugin = definePlugin({
  manifest: { name: "db-statefulset", description: "PostgreSQL as a plain StatefulSet." },
  validateConfig(section) {
    if (typeof section !== "object" || section === null) return ["must be a mapping"];
    const s = section as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(s))
      if (!["namespace", "namespaces", "image", "versions"].includes(key)) problems.push(`unknown key "${key}"`);
    if (!isKubeName(s.namespace)) problems.push("namespace must be a namespace name");
    if (s.namespaces !== undefined && (!Array.isArray(s.namespaces) || !s.namespaces.every(isKubeName))) {
      problems.push("namespaces must be a list of namespace names");
    }
    if (s.image !== undefined && (typeof s.image !== "string" || !/^[a-z0-9][a-z0-9./_-]*$/.test(s.image))) {
      problems.push("image must be an image repository without a tag");
    }
    if (
      s.versions !== undefined &&
      (!Array.isArray(s.versions) ||
        s.versions.length === 0 ||
        !s.versions.every((v) => typeof v === "string" && /^\d{2}$/.test(v)))
    ) {
      problems.push('versions must be a list of major versions, e.g. ["17"]');
    }
    return problems;
  },
  provides: {
    ports: ["databases"],
    needs: ["kube"],
    async create({ config, ports }) {
      // Outside a cluster there is nothing to run databases on.
      if (!ports.kube) return {};
      const c = config as { namespace: string; namespaces?: string[]; image?: string; versions?: string[] };
      return {
        databases: {
          statefulset: statefulSetPostgres({
            kube: ports.kube,
            namespace: c.namespace,
            namespaces: c.namespaces ?? [],
            ...(c.image ? { image: c.image } : {}),
            ...(c.versions ? { versions: c.versions } : {}),
          }),
        },
      };
    },
  },
});
