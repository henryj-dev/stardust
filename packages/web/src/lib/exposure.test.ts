import assert from "node:assert/strict";
import { it } from "node:test";
import { reachOf } from "./exposure.ts";

it("says where an edge proxy sends traffic, or why it cannot yet", () => {
  assert.deepEqual(
    reachOf([
      {
        name: "push",
        namespace: "pico",
        type: "LoadBalancer",
        ports: [
          { port: 8788, protocol: "TCP" },
          { port: 53, protocol: "UDP" },
        ],
        external: "10.0.0.9",
      },
      { name: "wait", namespace: "pico", type: "LoadBalancer", ports: [{ port: 80, protocol: "TCP" }], external: null },
      { name: "db", namespace: "pico", type: "ClusterIP", ports: [{ port: 5432, protocol: "TCP" }] },
      { name: "gone", namespace: "pico", error: "not applied yet" },
    ]).map((r) => [r.service, r.state, "upstreams" in r ? r.upstreams : r.note.split(";")[0]]),
    [
      ["push", "ready", ["10.0.0.9:8788"]],
      ["wait", "pending", "waiting for the cluster to give it an address"],
      ["db", "internal", "inside the cluster only"],
      ["gone", "error", "not applied yet"],
    ],
  );
});
