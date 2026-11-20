/**
 * An address outside the cluster for an instance: a LoadBalancer Service
 * `<instance>-db` beside the one inside, with a fixed cluster IP and its
 * own load-balancer address at the same offset in two blocks of one size:
 *
 *   clusterIPs: 10.0.0.0/24   → the Service's clusterIP is 10.0.0.N
 *   addresses:  10.0.8.0/24   → its address outside is    10.0.8.N
 *
 * N is the smallest offset that no Service stardust can see holds in either
 * block. A cluster IP cannot change once a Service exists, so an instance's
 * own Service is left alone: this one is separate. Pure: the feature reads
 * the repository and the cluster, this decides and renders.
 */
import { isKubeName } from "@stardust/core";
import { parseAllDocuments, stringify } from "yaml";

export interface ExternalSettings {
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
}

/** Where an instance's own address outside lives in its directory. */
export const EXTERNAL_FILE = "db.service.yaml";
export const externalServiceName = (instance: string) => `${instance}-db`;
export const POSTGRES_PORT = 5432;

export interface Blocks {
  cluster: { base: number; size: number };
  outside: { base: number; size: number };
  first: number;
  last: number;
}

export interface ExternalAddress {
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
export function externalProblems(s: unknown): string[] {
  if (typeof s !== "object" || s === null || Array.isArray(s)) return ["must be a mapping"];
  const e = s as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(e))
    if (!["clusterIPs", "addresses", "first", "last", "addressAnnotation", "labels", "annotations"].includes(key))
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
export function blocksOf(s: ExternalSettings): Blocks {
  const cluster = block(s.clusterIPs);
  const outside = block(s.addresses);
  if (typeof cluster === "string" || typeof outside === "string") throw new Error("invalid external settings");
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

interface ServiceObject {
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

/** The address outside a file gives `<instance>-db`, or null when it has none stardust can read. */
export function readExternal(text: string, instance: string, addressAnnotation: string): ExternalAddress | null {
  const svc = servicesIn(text).find((o) => o.metadata?.name === externalServiceName(instance));
  if (!svc) return null;
  const address =
    split(svc.metadata?.annotations?.[addressAnnotation]).find(isIPv4) ?? split(svc.spec?.loadBalancerIP).find(isIPv4);
  if (!address) return null;
  const clusterIP = split(svc.spec?.clusterIP).find(isIPv4) ?? null;
  return { clusterIP, address };
}

export interface ExternalService {
  instance: string;
  namespace: string;
  /** The labels of the instance's pods. */
  selector: Record<string, string>;
  clusterIP: string;
  address: string;
}

/**
 * The Service, in the shape an admission policy can hold it to: a
 * LoadBalancer with a fixed cluster IP, exactly one address of its own, no
 * node ports, and every node forwarding to the pod.
 */
export function renderExternalService(s: ExternalSettings, svc: ExternalService): string {
  if (!isKubeName(svc.instance) || !isKubeName(svc.namespace)) throw new Error("names must be names");
  if (!isIPv4(svc.clusterIP) || !isIPv4(svc.address)) throw new Error("addresses must be IPv4 addresses");
  if (Object.keys(svc.selector).length === 0) throw new Error("a Service with no selector would reach nothing");
  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: externalServiceName(svc.instance),
      namespace: svc.namespace,
      labels: {
        ...(s.labels ?? {}),
        "app.kubernetes.io/name": externalServiceName(svc.instance),
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
      ports: [{ name: "postgres", port: POSTGRES_PORT, targetPort: POSTGRES_PORT, protocol: "TCP" }],
    },
  };
  return stringify(service, { lineWidth: 0, aliasDuplicateObjects: false });
}
