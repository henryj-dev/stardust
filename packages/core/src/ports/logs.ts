/**
 * Pod logs. A `live` source reads pods that still exist (the Kubernetes
 * API); a `history` source reads what was collected and kept after a pod is
 * gone (Loki and the like). The `logs` port holds several, by name.
 */

export interface LogRequest {
  namespace: string;
  pod: string;
  container?: string;
  /** Keep the response open and send lines as they come (live sources only). */
  follow: boolean;
  /** Lines from the end. */
  tailLines?: number;
  /** Only lines from the last so many seconds. */
  sinceSeconds?: number;
  signal: AbortSignal;
}

export type LogResult = { state: "none" } | { state: "open"; body: AsyncIterable<Uint8Array> };

export interface LogSource {
  kind: "live" | "history";
  read(request: LogRequest): Promise<LogResult>;
}

/** Kubernetes object names: what a log request may name, so nothing else reaches a query. */
export const KUBE_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
