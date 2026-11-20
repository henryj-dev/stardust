import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import {
  addressesAt,
  addressesOf,
  blocksOf,
  type ExternalSettings,
  externalProblems,
  pickOffset,
  readExternal,
  renderExternalService,
  servicesIn,
  usedOffsets,
} from "./external.ts";

const SETTINGS: ExternalSettings = {
  clusterIPs: "10.0.0.0/21",
  addresses: "10.0.8.0/21",
  addressAnnotation: "lbipam.cilium.io/ips",
  labels: { "example.com/ip-block": "db" },
  annotations: { "service.cilium.io/forwarding-mode": "dsr" },
};

interface Svc {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec: {
    type?: string;
    clusterIP?: string;
    externalTrafficPolicy?: string;
    allocateLoadBalancerNodePorts?: boolean;
    selector?: Record<string, string>;
    ports?: Array<{ port: number; targetPort: number }>;
  };
}

const ip = (s: string) => s.split(".").reduce((n, o) => n * 256 + Number(o), 0);

/**
 * What an admission policy of the kind these Services meet asks: a
 * LoadBalancer with a fixed cluster IP in the block, exactly one address at
 * the same offset in the other block, the forwarding mode set, no node
 * ports, every node forwarding.
 */
function policyProblems(svc: Svc, s: ExternalSettings): string[] {
  const problems: string[] = [];
  const [cBase, cBits] = s.clusterIPs.split("/");
  const [aBase] = s.addresses.split("/");
  const size = 2 ** (32 - Number(cBits));
  if (svc.spec.type !== "LoadBalancer") problems.push("type");
  const cluster = svc.spec.clusterIP ?? "";
  const n = ip(cluster) - ip(cBase ?? "");
  const fixed = /^\d+\.\d+\.\d+\.\d+$/.test(cluster) && n >= 0 && n < size;
  if (!fixed) problems.push("clusterIP");
  const addresses = (svc.metadata.annotations?.[s.addressAnnotation] ?? "").split(",").filter(Boolean);
  if (addresses.length !== 1) problems.push("one address");
  else if (fixed && ip(addresses[0] ?? "") - ip(aBase ?? "") !== n) problems.push("1:1");
  for (const [k, v] of Object.entries(s.annotations ?? {}))
    if (svc.metadata.annotations?.[k] !== v) problems.push(`annotation ${k}`);
  for (const [k, v] of Object.entries(s.labels ?? {})) if (svc.metadata.labels?.[k] !== v) problems.push(`label ${k}`);
  if (svc.spec.externalTrafficPolicy !== "Cluster") problems.push("externalTrafficPolicy");
  if (svc.spec.allocateLoadBalancerNodePorts !== false) problems.push("node ports");
  return problems;
}

describe("an address outside the cluster", () => {
  const blocks = blocksOf(SETTINGS);
  const render = (n: number) =>
    renderExternalService(SETTINGS, {
      instance: "orders",
      namespace: "databases",
      selector: { "app.kubernetes.io/name": "orders" },
      ...addressesAt(blocks, n),
    });

  it("renders a LoadBalancer Service the admission policy lets in", () => {
    const svc = parse(render(12)) as Svc;
    assert.deepEqual(policyProblems(svc, SETTINGS), []);
    assert.equal(svc.metadata.name, "orders-db");
    assert.equal(svc.spec.clusterIP, "10.0.0.12");
    assert.equal(svc.metadata.annotations?.["lbipam.cilium.io/ips"], "10.0.8.12");
    assert.deepEqual(svc.spec.selector, { "app.kubernetes.io/name": "orders" });
    assert.deepEqual(
      svc.spec.ports?.map((p) => [p.port, p.targetPort]),
      [[5432, 5432]],
    );
    // Offsets past one octet stay one-to-one: /21 spans eight of them.
    const far = parse(render(300)) as Svc;
    assert.equal(far.spec.clusterIP, "10.0.1.44");
    assert.equal(far.metadata.annotations?.["lbipam.cilium.io/ips"], "10.0.9.44");
    assert.deepEqual(policyProblems(far, SETTINGS), []);
  });

  it("is held to the policy by a check that can fail, each condition on its own", () => {
    const good = parse(render(12)) as Svc;
    const broken: Array<[string, (s: Svc) => void]> = [
      ["type", (s) => delete s.spec.type],
      ["clusterIP", (s) => delete s.spec.clusterIP],
      [
        "one address",
        (s) => {
          if (s.metadata.annotations) s.metadata.annotations["lbipam.cilium.io/ips"] = "10.0.8.12,10.0.8.13";
        },
      ],
      [
        "1:1",
        (s) => {
          if (s.metadata.annotations) s.metadata.annotations["lbipam.cilium.io/ips"] = "10.0.8.13";
        },
      ],
      [
        "annotation service.cilium.io/forwarding-mode",
        (s) => delete s.metadata.annotations?.["service.cilium.io/forwarding-mode"],
      ],
      ["label example.com/ip-block", (s) => delete s.metadata.labels?.["example.com/ip-block"]],
      [
        "externalTrafficPolicy",
        (s) => {
          s.spec.externalTrafficPolicy = "Local";
        },
      ],
      ["node ports", (s) => delete s.spec.allocateLoadBalancerNodePorts],
    ];
    for (const [what, breakIt] of broken) {
      const svc = structuredClone(good);
      breakIt(svc);
      assert.deepEqual(policyProblems(svc, SETTINGS), [what], what);
    }
  });

  it("refuses to render what would reach nothing or carry a bad name", () => {
    const base = { instance: "orders", namespace: "databases", clusterIP: "10.0.0.1", address: "10.0.8.1" };
    assert.throws(() => renderExternalService(SETTINGS, { ...base, selector: {} }), /selector/);
    assert.throws(() => renderExternalService(SETTINGS, { ...base, selector: { a: "b" }, namespace: "No" }));
    assert.throws(() => renderExternalService(SETTINGS, { ...base, selector: { a: "b" }, address: "10.0.8" }));
  });
});

describe("choosing N", () => {
  const blocks = blocksOf(SETTINGS);

  it("takes the smallest offset free in both blocks", () => {
    assert.equal(pickOffset(blocks, new Set()), 1);
    // .1 holds a cluster IP, .2 an address outside: neither can be used for either.
    const used = usedOffsets(blocks, ["10.0.0.1", "10.0.8.2", "10.0.8.3", "192.0.2.4", "not an ip"]);
    assert.deepEqual([...used].sort(), [1, 2, 3]);
    assert.equal(pickOffset(blocks, used), 4);
  });

  it("reads every address a Service holds: cluster IPs, the annotation, the asked-for and given addresses", () => {
    const [svc] = servicesIn(
      [
        "apiVersion: v1",
        "kind: Service",
        "metadata:",
        "  name: other",
        "  annotations:",
        '    lbipam.cilium.io/ips: "10.0.8.7, 10.0.8.9"',
        "spec:",
        "  clusterIP: 10.0.0.5",
        "  clusterIPs: [10.0.0.5]",
        "  loadBalancerIP: 10.0.8.11",
        "status:",
        "  loadBalancer:",
        "    ingress: [{ ip: 10.0.8.13 }]",
        "---",
        "kind: ConfigMap",
        "metadata: { name: not-a-service }",
      ].join("\n"),
    );
    assert.ok(svc);
    const used = usedOffsets(blocks, addressesOf(svc, SETTINGS.addressAnnotation));
    assert.deepEqual(
      [...used].sort((a, b) => a - b),
      [5, 7, 9, 11, 13],
    );
    assert.equal(servicesIn("kind: [unclosed").length, 0, "what does not parse holds nothing");
  });

  it("stays within first and last, and says so when every one is taken", () => {
    const narrow = blocksOf({ ...SETTINGS, first: 10, last: 12 });
    assert.equal(pickOffset(narrow, new Set()), 10);
    assert.equal(pickOffset(narrow, new Set([10, 11])), 12);
    assert.equal(pickOffset(narrow, new Set([10, 11, 12])), null);
    assert.equal(blocks.last, 2046, "by default the block's second-last");
  });
});

describe("recognising one written by hand", () => {
  it("reads its address and cluster IP, and nothing from another Service", () => {
    const text = [
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: legacy-db",
      "  annotations: { lbipam.cilium.io/ips: 10.0.8.40 }",
      "spec: { type: LoadBalancer, clusterIP: 10.0.0.40 }",
    ].join("\n");
    assert.deepEqual(readExternal(text, "legacy", SETTINGS.addressAnnotation), {
      clusterIP: "10.0.0.40",
      address: "10.0.8.40",
    });
    assert.equal(readExternal(text, "orders", SETTINGS.addressAnnotation), null);
    assert.equal(readExternal(text.replace("lbipam.cilium.io/ips", "x/y"), "legacy", SETTINGS.addressAnnotation), null);
  });
});

describe("the settings", () => {
  it("accept blocks of one size, apart, with an annotation to carry the address", () => {
    assert.deepEqual(externalProblems(SETTINGS), []);
    const bad: Array<[Partial<Record<keyof ExternalSettings | "extra", unknown>>, RegExp]> = [
      [{ clusterIPs: "10.0.0.0/20" }, /one size/],
      [{ addresses: "10.0.0.0/21" }, /overlap/],
      [{ clusterIPs: "10.0.0.1/21" }, /start its block: 10\.0\.0\.0\/21/],
      [{ addresses: "fd00::/120" }, /IPv4 block/],
      [{ first: 0, last: 5000 }, /within the block/],
      [{ first: 9, last: 3 }, /within the block/],
      [{ first: 1.5 }, /whole numbers/],
      [{ addressAnnotation: "has space" }, /addressAnnotation/],
      [{ labels: { "example.com/ip-block": "not ok!" } }, /labels\./],
      [{ annotations: { "lbipam.cilium.io/ips": "10.0.8.1" } }, /must not set addressAnnotation/],
      [{ extra: true }, /unknown key/],
    ];
    for (const [over, expected] of bad) {
      const problems = externalProblems({ ...SETTINGS, ...over });
      assert.ok(
        problems.some((p) => expected.test(p)),
        `${JSON.stringify(over)}: ${problems.join("; ")}`,
      );
    }
  });
});
