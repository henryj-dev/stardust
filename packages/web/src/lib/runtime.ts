/** What the runtime plugin returns for a component. */
export interface RuntimeView {
  component: string;
  deployDir: string;
  workloads: Array<
    | {
        kind: string;
        name: string;
        namespace: string;
        desired: number | null;
        ready: number;
        updated: number;
        available: number;
        pods: Array<{
          name: string;
          phase: string;
          ready: boolean;
          restarts: number;
          node: string | null;
          startedAt: string | null;
          containers: Array<{ name: string; ready: boolean; restarts: number; state: string; reason: string | null }>;
        }>;
        events: Array<{
          type: string;
          reason: string;
          message: string;
          object: string;
          at: string | null;
          count: number;
        }>;
      }
    | { kind: string; name: string; error: string }
  >;
  /** The Services its manifests declare, as they run. Absent from older servers. */
  services?: ServiceView[];
}

export interface ServiceView {
  name: string;
  namespace: string | null;
  type?: string;
  ports?: Array<{ port: number; protocol: string }>;
  /** The address outside the cluster a LoadBalancer got. */
  external?: string | null;
  error?: string;
}
