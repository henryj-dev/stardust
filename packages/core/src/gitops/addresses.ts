/**
 * An address outside the cluster for a Service, in the shape an admission
 * policy can hold it to: a LoadBalancer with a fixed cluster IP and its own
 * load-balancer address at the same offset in two blocks of one size:
 *
 *   clusterIPs: 10.0.0.0/24   → the Service's clusterIP is 10.0.0.N
 *   addresses:  10.0.8.0/24   → its address outside is    10.0.8.N
 *
 * N is the smallest offset nothing holds in either block. What holds one is
 * read from every manifest in the deploy repository a caller scans (any
 * Service's clusterIP, clusterIPs, loadBalancerIP and address annotation),
 * plus what it records and what the cluster says, when it may ask. Shared by
 * the databases and the runtime plugins, which give out addresses from the
 * same blocks. Pure, except `heldInRepository`, which only reads.
 */
import { parseAllDocuments, stringify } from "yaml";
import type { BoundRepo } from "./cas.ts";

export interface AddressSettings {
  /** The block the fixed cluster IPs come from (inside the cluster's Service range). */
  clusterIPs: string;
  /** The block the addresses outside come from, as large as `clusterIPs`: the same N in each. */
  addresses: string;
  /** The lowest and highest N to give out (default: 1 to the block's second-last). */
  first?: number;
  last?: number;
  /** The annotation the load balancer reads its address from, e.g. lbipam.cilium.io/ips. */
  addressAnnotation: string;
  /** Labels and annotations every such Service carries, e.g. the one that picks its address pool. */
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /**
   * Directories of the deploy repository whose manifests are read for the
   * addresses Services hold already (default: the whole repository, "").
   * Every directory a Service with an address in these blocks may live in
   * must be below one of them.
   */
  scan?: string[];
}

export interface Blocks {
  cluster: { base: number; size: number };
  outside: { base: number; size: number };
  first: number;
  last: number;
}

export interface FixedAddress {
  clusterIP: string | null;
  address: string;
}

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

export const isIPv4 = (v: unknown): v is string => typeof v === "string" && IPV4.test(v);
const toInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

/** A block as base and size, or why it is not one. */
function block(cidr: unknown): { base: number; size: number } | string {
  if (typeof cidr !== "string") return "must be an IPv4 block such as 10.0.0.0/24";
  const [ip, bits, ...rest] = cidr.split("/");
  const prefix = Number(bits);
  if (rest.length > 0 || !isIPv4(ip) || !/^\d{1,2}$/.test(bits ?? "") || prefix < 16 || prefix > 30)
    return "must be an IPv4 block from /16 to /30, such as 10.0.0.0/24";
  const size = 2 ** (32 - prefix);
  const base = toInt(ip);
  if (base % size !== 0) return `must start its block: ${toIp(base - (base % size))}/${prefix}`;
  return { base, size };
}

const KEY =
  /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const isKey = (k: string) => k.length <= 316 && KEY.test(k) && (k.split("/").at(-1)?.length ?? 0) <= 63;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

function mapProblems(what: string, m: unknown, values: (v: string) => boolean): string[] {
  if (m === undefined) return [];
  if (typeof m !== "object" || m === null || Array.isArray(m)) return [`${what} must be a mapping`];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (!isKey(k)) problems.push(`${what}: "${k}" is not a key Kubernetes accepts`);
    if (typeof v !== "string" || !values(v)) problems.push(`${what}.${k} must be a string Kubernetes accepts`);
  }
  return problems;
}

/** Why a settings section cannot be used, or nothing. */
export function addressSettingsProblems(s: unknown): string[] {
  if (typeof s !== "object" || s === null || Array.isArray(s)) return ["must be a mapping"];
  const e = s as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(e))
    if (
      !["clusterIPs", "addresses", "first", "last", "addressAnnotation", "labels", "annotations", "scan"].includes(key)
    )
      problems.push(`unknown key "${key}"`);
  const cluster = block(e.clusterIPs);
  const outside = block(e.addresses);
  if (typeof cluster === "string") problems.push(`clusterIPs ${cluster}`);
  if (typeof outside === "string") problems.push(`addresses ${outside}`);
  if (typeof cluster !== "string" && typeof outside !== "string") {
    if (cluster.size !== outside.size)
      problems.push("clusterIPs and addresses must be blocks of one size: N is the same offset in each");
    if (cluster.base < outside.base + outside.size && outside.base < cluster.base + cluster.size)
      problems.push("clusterIPs and addresses must not overlap");
    const first = e.first ?? 1;
    const last = e.last ?? cluster.size - 2;
    if (!Number.isInteger(first) || !Number.isInteger(last) || (first as number) < 0)
      problems.push("first and last must be whole numbers");
    else if ((first as number) > (last as number) || (last as number) > cluster.size - 1)
      problems.push(`first and last must be within the block: 0 to ${cluster.size - 1}, first not above last`);
  }
  if (typeof e.addressAnnotation !== "string" || !isKey(e.addressAnnotation))
    problems.push("addressAnnotation must name the annotation the load balancer reads, e.g. lbipam.cilium.io/ips");
  if (
    e.scan !== undefined &&
    (!Array.isArray(e.scan) ||
      e.scan.some((d) => typeof d !== "string" || d.startsWith("/") || d.split("/").some((p) => p === "..")))
  )
    problems.push(
      'scan must be a list of directories of the deploy repository, such as "clusters/one" ("" is all of it)',
    );
  problems.push(...mapProblems("labels", e.labels, (v) => v.length <= 63 && LABEL_VALUE.test(v)));
  problems.push(...mapProblems("annotations", e.annotations, () => true));
  if (
    typeof e.addressAnnotation === "string" &&
    e.annotations &&
    typeof e.annotations === "object" &&
    e.addressAnnotation in e.annotations
  )
    problems.push("annotations must not set addressAnnotation: stardust writes each Service's own address there");
  return problems;
}

/** The settings as numbers. Call only with settings that have no problems. */
export function blocksOf(s: AddressSettings): Blocks {
  const cluster = block(s.clusterIPs);
  const outside = block(s.addresses);
  if (typeof cluster === "string" || typeof outside === "string") throw new Error("invalid address settings");
  return { cluster, outside, first: s.first ?? 1, last: s.last ?? cluster.size - 2 };
}

/** The two addresses at offset N. */
export const addressesAt = (b: Blocks, n: number) => ({
  clusterIP: toIp(b.cluster.base + n),
  address: toIp(b.outside.base + n),
});

/** The offsets these addresses hold, in either block. */
export function usedOffsets(b: Blocks, ips: Iterable<string>): Set<number> {
  const used = new Set<number>();
  for (const ip of ips) {
    if (!isIPv4(ip)) continue;
    const n = toInt(ip);
    for (const blk of [b.cluster, b.outside]) if (n >= blk.base && n < blk.base + blk.size) used.add(n - blk.base);
  }
  return used;
}

/** The smallest free N, or null when every one is taken. */
export function pickOffset(b: Blocks, used: ReadonlySet<number>): number | null {
  for (let n = b.first; n <= b.last; n++) if (!used.has(n)) return n;
  return null;
}

export interface ServiceObject {
  kind?: string;
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, unknown> };
  spec?: { clusterIP?: unknown; clusterIPs?: unknown; loadBalancerIP?: unknown };
  status?: { loadBalancer?: { ingress?: Array<{ ip?: unknown }> } };
}

const split = (v: unknown) =>
  typeof v === "string"
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/** Every address a Service holds: its cluster IPs, its load-balancer addresses (annotated, asked for or given). */
export function addressesOf(o: ServiceObject, addressAnnotation: string): string[] {
  const ips = [
    ...split(o.spec?.clusterIP),
    ...(Array.isArray(o.spec?.clusterIPs) ? o.spec.clusterIPs.flatMap(split) : []),
    ...split(o.spec?.loadBalancerIP),
    ...split(o.metadata?.annotations?.[addressAnnotation]),
    ...(o.status?.loadBalancer?.ingress ?? []).flatMap((i) => split(i.ip)),
  ];
  return ips.filter(isIPv4);
}

/** The Services in a manifest file; anything that does not parse holds none. */
export function servicesIn(text: string): ServiceObject[] {
  const found: ServiceObject[] = [];
  for (const d of parseAllDocuments(text)) {
    if (d.errors.length > 0) continue;
    const o = d.toJS() as ServiceObject | null;
    if (o && typeof o === "object" && o.kind === "Service") found.push(o);
  }
  return found;
}

/** The Services of a list the API answered (GET /api/v1/services). */
export function servicesInList(body: string): ServiceObject[] {
  try {
    const items = (JSON.parse(body) as { items?: unknown }).items;
    return Array.isArray(items) ? (items as ServiceObject[]) : [];
  } catch {
    return [];
  }
}

const isName = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v);

export interface LoadBalancerService {
  name: string;
  namespace: string;
  /** The labels of the pods it sends to. */
  selector: Record<string, string>;
  clusterIP: string;
  address: string;
  ports: Array<{ name?: string; port: number; targetPort: number; protocol?: "TCP" | "UDP" }>;
}

/**
 * The Service, in the shape an admission policy can hold it to: a
 * LoadBalancer with a fixed cluster IP, exactly one address of its own, no
 * node ports, every node forwarding to the pod, and the settings' labels and
 * annotations (such as the forwarding mode).
 */
export function renderLoadBalancer(s: AddressSettings, svc: LoadBalancerService): string {
  if (!isName(svc.name) || !isName(svc.namespace)) throw new Error("names must be names");
  if (!isIPv4(svc.clusterIP) || !isIPv4(svc.address)) throw new Error("addresses must be IPv4 addresses");
  if (Object.keys(svc.selector).length === 0) throw new Error("a Service with no selector would reach nothing");
  if (svc.ports.length === 0) throw new Error("a Service needs a port");
  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: svc.name,
      namespace: svc.namespace,
      labels: {
        ...(s.labels ?? {}),
        "app.kubernetes.io/name": svc.name,
        "app.kubernetes.io/managed-by": "stardust",
      },
      annotations: { ...(s.annotations ?? {}), [s.addressAnnotation]: svc.address },
    },
    spec: {
      type: "LoadBalancer",
      clusterIP: svc.clusterIP,
      externalTrafficPolicy: "Cluster",
      allocateLoadBalancerNodePorts: false,
      selector: svc.selector,
      ports: svc.ports.map((p) => ({
        ...(p.name ? { name: p.name } : {}),
        port: p.port,
        targetPort: p.targetPort,
        protocol: p.protocol ?? "TCP",
      })),
    },
  };
  return stringify(service, { lineWidth: 0, aliasDuplicateObjects: false });
}

/**
 * Why an admission policy of the kind these Services meet would refuse one:
 * a LoadBalancer with a fixed cluster IP in the block, exactly one address at
 * the same offset in the other, the settings' labels and annotations, no
 * node ports, every node forwarding. Nothing when it would admit it.
 */
export function addressPolicyProblems(svc: ServiceObject, s: AddressSettings): string[] {
  const b = blocksOf(s);
  const o = svc as ServiceObject & {
    metadata?: { labels?: Record<string, unknown> };
    spec?: { type?: unknown; externalTrafficPolicy?: unknown; allocateLoadBalancerNodePorts?: unknown };
  };
  const problems: string[] = [];
  if (o.spec?.type !== "LoadBalancer") problems.push("it is not a LoadBalancer");
  const cluster = split(o.spec?.clusterIP).filter(isIPv4);
  const n = cluster.length === 1 ? toInt(cluster[0] as string) - b.cluster.base : -1;
  const fixed = n >= 0 && n < b.cluster.size;
  if (!fixed) problems.push(`its clusterIP is not one fixed address in ${s.clusterIPs}`);
  const addresses = split(o.metadata?.annotations?.[s.addressAnnotation]).filter(isIPv4);
  if (addresses.length !== 1) problems.push(`it does not name exactly one address in ${s.addressAnnotation}`);
  else if (fixed && toInt(addresses[0] as string) - b.outside.base !== n)
    problems.push(`its address is not at the same offset in ${s.addresses} as its clusterIP`);
  for (const [k, v] of Object.entries(s.annotations ?? {}))
    if (o.metadata?.annotations?.[k] !== v) problems.push(`it lacks the annotation ${k}: ${v}`);
  for (const [k, v] of Object.entries(s.labels ?? {}))
    if (o.metadata?.labels?.[k] !== v) problems.push(`it lacks the label ${k}: ${v}`);
  if (o.spec?.externalTrafficPolicy !== "Cluster") problems.push("externalTrafficPolicy is not Cluster");
  if (o.spec?.allocateLoadBalancerNodePorts !== false) problems.push("it allocates node ports");
  return problems;
}

/**
 * Every address any Service in these directories of the repository holds,
 * read from every manifest below them (sealed `.enc.yaml` files are not
 * read: they hold Secrets). "" is the whole repository. Directories are told
 * from files by listing them, as Git lists a tree.
 */
export async function heldInRepository(
  at: BoundRepo,
  dirs: readonly string[],
  addressAnnotation: string,
  options: { maxFiles?: number } = {},
): Promise<{ addresses: string[]; services: Array<{ path: string; service: ServiceObject }> }> {
  const max = options.maxFiles ?? 20000;
  const addresses: string[] = [];
  const services: Array<{ path: string; service: ServiceObject }> = [];
  const seen = new Set<string>();
  let read = 0;
  const walk = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);
    for (const name of await at.list(dir)) {
      if (name.startsWith(".")) continue;
      const path = dir ? `${dir}/${name}` : name;
      if (/\.ya?ml$/.test(name)) {
        if (/\.enc\.ya?ml$/.test(name)) continue;
        if (++read > max) throw new Error(`more than ${max} manifests to scan: narrow the directories scanned`);
        const file = await at.read(path);
        if (!file) {
          await walk(path);
          continue;
        }
        for (const service of servicesIn(file.content)) {
          services.push({ path, service });
          addresses.push(...addressesOf(service, addressAnnotation));
        }
      } else if (!name.includes(".") || (await at.read(path)) === null) {
        // A directory (or a file of another kind, which lists nothing).
        await walk(path);
      }
    }
  };
  for (const d of dirs) await walk(d.replace(/\/+$/, ""));
  return { addresses, services };
}
