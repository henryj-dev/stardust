/**
 * Who actually uses a Secret, and whether a change has reached them.
 *
 * A running process does not see an edited Secret: environment variables are
 * read at start. So an edit must reach the workloads that use it — and when
 * none does, the answer is "nothing uses this", never "applied".
 *
 * A Secret is referenced three ways, and missing one misses consumers:
 *   envFrom[].secretRef.name             the whole Secret
 *   env[].valueFrom.secretKeyRef.name    one key
 *   volumes[].secret.secretName          mounted files (registry configs, PEMs)
 * imagePullSecrets reference it too, but the kubelet reads those when pulling,
 * so restarting for them gains nothing: they are reported, not restarted.
 */

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";
export type Via = "envFrom" | "envKey" | "volume" | "imagePullSecret";

export interface Consumer {
  kind: WorkloadKind;
  namespace: string;
  name: string;
  via: Via[];
  /** Whether rolling the workload makes it read the change. */
  restartable: boolean;
}

interface Container {
  envFrom?: Array<{ secretRef?: { name?: string }; configMapRef?: { name?: string } }>;
  env?: Array<{ valueFrom?: { secretKeyRef?: { name?: string }; configMapKeyRef?: { name?: string } } }>;
}

export interface WorkloadLike {
  kind: WorkloadKind;
  metadata: { name: string; namespace: string };
  spec: {
    template: {
      metadata?: { annotations?: Record<string, string> };
      spec: {
        containers?: Container[];
        initContainers?: Container[];
        volumes?: Array<{ secret?: { secretName?: string }; configMap?: { name?: string } }>;
        imagePullSecrets?: Array<{ name?: string }>;
      };
    };
  };
}

export function findSecretConsumers(workloads: readonly WorkloadLike[], namespace: string, secret: string): Consumer[] {
  const out: Consumer[] = [];
  for (const w of workloads) {
    if (w.metadata.namespace !== namespace) continue;
    const spec = w.spec?.template?.spec ?? {};
    const via = new Set<Via>();
    for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
      if (c.envFrom?.some((e) => e.secretRef?.name === secret)) via.add("envFrom");
      if (c.env?.some((e) => e.valueFrom?.secretKeyRef?.name === secret)) via.add("envKey");
    }
    if (spec.volumes?.some((v) => v.secret?.secretName === secret)) via.add("volume");
    if (spec.imagePullSecrets?.some((p) => p.name === secret)) via.add("imagePullSecret");
    if (via.size === 0) continue;
    const list = [...via];
    out.push({
      kind: w.kind,
      namespace: w.metadata.namespace,
      name: w.metadata.name,
      via: list,
      restartable: list.some((v) => v !== "imagePullSecret"),
    });
  }
  return out;
}

export interface LiveEnvState {
  /** The ConfigMap's and the Secret's revision annotations, or null when the object is missing. */
  configMap: { revision: string | null } | null;
  secret: { revision: string | null } | null;
  /** The workload's pod template revision annotation, and whether its rollout is complete. */
  workload: { templateRevision: string | null; rolledOut: boolean } | null;
}

export type Landing =
  /** The workload runs pods started with this revision. */
  | "live"
  /** Committed, but the GitOps controller has not created or updated the objects yet. */
  | "committed-not-applied"
  /** The objects carry the revision, but the workload has not rolled out with it yet. */
  | "applied-not-rolled-out"
  /** The env objects exist but no workload is stamped with this revision: nothing restarts. */
  | "no-consumer";

/**
 * Where a change stands. "Committed" and "running" are different claims; this
 * answers the second, from what the cluster reports, not from what was written.
 */
export function envLanding(state: LiveEnvState, revision: string): Landing {
  const objectsHave = state.configMap?.revision === revision && state.secret?.revision === revision;
  if (!objectsHave) return "committed-not-applied";
  if (!state.workload) return "no-consumer";
  if (state.workload.templateRevision !== revision || !state.workload.rolledOut) return "applied-not-rolled-out";
  return "live";
}
