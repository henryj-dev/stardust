/**
 * How a component's Services can be reached from outside the cluster, said
 * for the person who sets up the edge proxy: stardust gives a Service an
 * address (a LoadBalancer); routing a public host to it, and DNS, happen at
 * the edge.
 */
import type { ServiceView } from "./runtime";

export type Reach =
  | { service: string; state: "ready"; upstreams: string[] }
  | { service: string; state: "pending" | "internal"; note: string }
  | { service: string; state: "error"; note: string };

export function reachOf(services: readonly ServiceView[]): Reach[] {
  return services.map((s): Reach => {
    if (s.error) return { service: s.name, state: "error", note: s.error };
    if (s.type !== "LoadBalancer") {
      return {
        service: s.name,
        state: "internal",
        note: "inside the cluster only; make it a LoadBalancer (scaffold with “expose”) to give it an address an edge proxy can reach",
      };
    }
    if (!s.external)
      return { service: s.name, state: "pending", note: "waiting for the cluster to give it an address" };
    const tcp = (s.ports ?? []).filter((p) => p.protocol === "TCP");
    return { service: s.name, state: "ready", upstreams: tcp.map((p) => `${s.external}:${p.port}`) };
  });
}
