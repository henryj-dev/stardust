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
}
