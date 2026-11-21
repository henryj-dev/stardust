import assert from "node:assert/strict";
import { it } from "node:test";
import { MemoryRepo } from "../testing.ts";
import {
  type AddressSettings,
  addressesAt,
  addressPolicyProblems,
  addressSettingsProblems,
  blocksOf,
  heldInRepository,
  pickOffset,
  renderLoadBalancer,
  servicesIn,
} from "./addresses.ts";

const SETTINGS: AddressSettings = {
  clusterIPs: "10.0.0.0/24",
  addresses: "10.0.8.0/24",
  reserved: [],
  first: 10,
  last: 20,
  addressAnnotation: "lbipam.cilium.io/ips",
  labels: { "example.com/pool": "apps" },
  annotations: { "service.cilium.io/forwarding-mode": "dsr" },
};

const service = (n = 10) =>
  renderLoadBalancer(SETTINGS, {
    name: "server-vip",
    namespace: "app",
    selector: { app: "server" },
    ...addressesAt(blocksOf(SETTINGS), n),
    ports: [{ port: 8080, targetPort: 8080 }],
  });

it("renders a Service the address policy admits: fixed cluster IP, one address at the same N, DSR, no node ports", () => {
  const [svc] = servicesIn(service(12));
  assert.ok(svc);
  assert.deepEqual(addressPolicyProblems(svc, SETTINGS), []);
  assert.equal((svc as { spec: { clusterIP: string } }).spec.clusterIP, "10.0.0.12");
  assert.equal(svc.metadata?.annotations?.["lbipam.cilium.io/ips"], "10.0.8.12");
});

it("names what the policy would refuse", () => {
  const [svc] = servicesIn(service());
  type Svc = {
    metadata: { labels: Record<string, string>; annotations: Record<string, string> };
    spec: Record<string, unknown>;
  };
  const broken = (edit: (o: Svc) => void, re: RegExp) => {
    const o = structuredClone(svc) as unknown as Svc;
    edit(o);
    const problems = addressPolicyProblems(o as never, SETTINGS);
    assert.ok(
      problems.some((p) => re.test(p)),
      problems.join("; "),
    );
  };
  broken((o) => delete o.spec.clusterIP, /clusterIP/);
  broken((o) => (o.spec.clusterIP = "10.0.1.10"), /clusterIP/);
  broken((o) => (o.metadata.annotations["lbipam.cilium.io/ips"] = "10.0.8.11"), /same offset/);
  broken((o) => (o.metadata.annotations["lbipam.cilium.io/ips"] = "10.0.8.10,10.0.8.11"), /exactly one/);
  broken((o) => delete o.metadata.annotations["service.cilium.io/forwarding-mode"], /forwarding-mode/);
  broken((o) => delete o.metadata.labels["example.com/pool"], /label/);
  broken((o) => (o.spec.type = "ClusterIP"), /LoadBalancer/);
  broken((o) => delete o.spec.allocateLoadBalancerNodePorts, /node ports/);
  broken((o) => (o.spec.externalTrafficPolicy = "Local"), /externalTrafficPolicy/);
});

it("reads every Service's addresses in the scanned directories, at any depth, and no sealed file", async () => {
  const repo = new MemoryRepo({
    "clusters/one/apps/shop/vip.yaml": service(11).replace("server-vip", "shop-vip"),
    "clusters/one/apps/shop/deep/more/svc.yaml":
      "apiVersion: v1\nkind: Service\nmetadata: { name: a }\nspec: { clusterIPs: [10.0.0.13], loadBalancerIP: 10.0.8.14 }\n",
    "clusters/one/apps/shop/secret.enc.yaml": "kind: Service\nspec: { clusterIP: 10.0.0.15 }\n",
    "clusters/two/x.yaml": "kind: Service\nspec: { clusterIP: 10.0.0.16 }\n",
    "README.md": "not a manifest",
  });
  const head = await repo.headSha();
  const at = { read: (p: string) => repo.readFile(p, head), list: (p: string) => repo.listDir(p, head) };
  const one = await heldInRepository(at, ["clusters/one"], SETTINGS.addressAnnotation);
  assert.deepEqual(one.addresses.sort(), ["10.0.0.11", "10.0.0.13", "10.0.8.11", "10.0.8.14"]);
  const all = await heldInRepository(at, [""], SETTINGS.addressAnnotation);
  assert.ok(all.addresses.includes("10.0.0.16"), "the whole repository with an empty path");
  assert.ok(!all.addresses.includes("10.0.0.15"), "sealed files are not read");
  assert.deepEqual(
    all.services.map((s) => s.path),
    ["clusters/one/apps/shop/deep/more/svc.yaml", "clusters/one/apps/shop/vip.yaml", "clusters/two/x.yaml"],
  );
});

it("takes scan as directories of the repository only", () => {
  assert.deepEqual(addressSettingsProblems({ ...SETTINGS, scan: ["clusters/one", ""] }), []);
  assert.equal(addressSettingsProblems({ ...SETTINGS, scan: ["/etc"] }).length, 1);
  assert.equal(addressSettingsProblems({ ...SETTINGS, scan: ["a/../b"] }).length, 1);
});

it("never gives out what Kubernetes holds at the start of the Service range, nor the block's ends", () => {
  // A block starting the Service range, default first, the cluster not listable:
  // .1 (default/kubernetes) was given out and the GitOps controller's apply stopped.
  const b = blocksOf({
    clusterIPs: "10.96.0.0/20",
    addresses: "10.96.32.0/20",
    addressAnnotation: SETTINGS.addressAnnotation,
  });
  assert.equal(pickOffset(b, new Set()), 2, ".1 is default/kubernetes");
  assert.equal(pickOffset(b, new Set([2, 3, 4, 5, 6, 7, 8, 9])), 11, ".10 is the cluster DNS");
  const own = blocksOf({ ...SETTINGS, first: 1, last: 5, reserved: [2] });
  assert.equal(pickOffset(own, new Set()), 1, "reserved replaces the default");
  assert.equal(pickOffset(own, new Set([1])), 3);
  const ends = blocksOf({
    ...SETTINGS,
    clusterIPs: "10.0.0.0/30",
    addresses: "10.0.8.0/30",
    first: 0,
    last: 3,
    reserved: [],
  });
  assert.equal(
    pickOffset(ends, new Set([1, 2])),
    null,
    "network and broadcast stay out even when the settings allow them",
  );
});

it("refuses reserved offsets outside the block", () => {
  assert.deepEqual(addressSettingsProblems({ ...SETTINGS, reserved: [1, 10] }), []);
  for (const reserved of [[256], [-1], [1.5], "1"])
    assert.ok(
      addressSettingsProblems({ ...SETTINGS, reserved }).some((p) => /reserved/.test(p)),
      JSON.stringify(reserved),
    );
});
