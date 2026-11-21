/**
 * A component's address outside the cluster, for an edge proxy or another
 * network to reach it: a LoadBalancer Service `<component>-vip` in
 * `stardust-address.service.yaml`, listed in the kustomization, with a fixed
 * cluster IP and its own address at the same offset of two blocks (see
 * @stardust/core gitops/addresses), the shape an admission policy holds such
 * Services to. Configured as `runtime.external`; an administrator adds or
 * removes it (`runtime:address`), audited.
 *
 * N must not collide with any address already held, so it is picked from
 * everything that can be seen: every Service in the scanned directories of
 * the deploy repository (not only the component's own), the addresses the
 * databases plugin recorded, and the cluster's Services when stardust may
 * list them. A Service of the same name in the repository or the cluster is
 * refused (409): a second one with another cluster IP stops the GitOps
 * controller's dry-run.
 */
import {
  type AddressSettings,
  addResource,
  addressesAt,
  addressesOf,
  addressPolicyProblems,
  blocksOf,
  commitWithCas,
  type Database,
  findWorkloads,
  heldInRepository,
  type KubeClient,
  type Logger,
  pickOffset,
  type RepoIO,
  type Route,
  removeResource,
  renderLoadBalancer,
  servicesIn,
  servicesInList,
  usedOffsets,
  WorkloadEditError,
  workloadNamespace,
} from "@stardust/core";
import { parseAllDocuments } from "yaml";
import { answer, atHead, type ComponentRef, dirOf, readDir } from "./settings.ts";

export const ADDRESS_FILE = "stardust-address.service.yaml";
export const addressServiceName = (component: string) => `${component}-vip`;
const KUSTOMIZATIONS = ["kustomization.yaml", "kustomization.yml"];

class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The ports to send: as asked, or every container port of the component's workloads. */
function portsOf(files: ReadonlyMap<string, string>, component: string, body: unknown) {
  const asked = (body as { ports?: unknown } | null)?.ports;
  if (asked !== undefined) {
    if (!Array.isArray(asked) || asked.length === 0 || asked.length > 16)
      throw new Refused(400, "ports must be a list of { port, targetPort }");
    const mapped = asked.map((p, i) => {
      const { port, targetPort = port } = (p ?? {}) as { port?: unknown; targetPort?: unknown };
      for (const v of [port, targetPort])
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535)
          throw new Refused(400, `ports.${i} must be 1-65535`);
      return { name: `p${port}`, port: port as number, targetPort: targetPort as number };
    });
    const twice = mapped.find((p, i) => mapped.findIndex((q) => q.port === p.port) !== i);
    // Two entries for one port make the API server refuse the Service, which stops the GitOps controller.
    if (twice) throw new Refused(400, `port ${twice.port} is given twice`);
    return mapped;
  }
  const found = new Set<number>();
  for (const file of new Set(findWorkloads(files).map((w) => w.file))) {
    for (const doc of parseAllDocuments(files.get(file) ?? "")) {
      if (doc.errors.length > 0) continue;
      const o = doc.toJS() as {
        spec?: { template?: { spec?: { containers?: Array<{ ports?: Array<{ containerPort?: unknown }> }> } } };
      } | null;
      for (const ctr of o?.spec?.template?.spec?.containers ?? [])
        for (const p of ctr.ports ?? []) if (typeof p.containerPort === "number") found.add(p.containerPort);
    }
  }
  if (found.size === 0)
    throw new Refused(400, `${component}'s containers name no port: give ports: [{ port, targetPort }]`);
  return [...found].sort((a, b) => a - b).map((p) => ({ name: `p${p}`, port: p, targetPort: p }));
}

export function addressRoutes(input: {
  repo: RepoIO;
  component: (params: Readonly<Record<string, string>>) => Promise<ComponentRef | null>;
  settings: AddressSettings | undefined;
  kube: KubeClient;
  database: Database | undefined;
  log: Logger;
}): Route[] {
  const { repo, component, settings, kube, database, log } = input;
  const path = "/projects/:project/components/:component/address";

  /** Addresses the databases plugin recorded, when its table is there. */
  const recorded = async (): Promise<string[]> => {
    if (!database) return [];
    try {
      const [t] = await database.query<{ t: string | null }>("SELECT to_regclass('databases_instances')::text AS t");
      if (!t?.t) return [];
      const rows = await database.query<{ a: string | null; c: string | null }>(
        "SELECT external_address AS a, external_cluster_ip AS c FROM databases_instances",
      );
      return rows.flatMap((r) => [r.a ?? "", r.c ?? ""]);
    } catch (err) {
      log.warn("runtime: could not read the addresses the databases recorded", { reason: (err as Error).message });
      return [];
    }
  };

  /** Every Service's addresses in the cluster, when stardust may list them (the chart does not grant it). */
  const inCluster = async (annotation: string): Promise<string[]> => {
    try {
      const res = await kube.request("GET", "/api/v1/services");
      if (res.status === 200) return servicesInList(res.body).flatMap((o) => addressesOf(o, annotation));
      log.warn("runtime: could not list the cluster's Services; picking from the repository and records only", {
        reason: `the API answered ${res.status}`,
      });
      return [];
    } catch (err) {
      log.warn("runtime: could not list the cluster's Services; picking from the repository and records only", {
        reason: (err as Error).message,
      });
      return [];
    }
  };

  /** Whether the cluster has a Service of this name; null when that cannot be read (then it is logged). */
  const serviceInCluster = async (namespace: string, name: string): Promise<boolean | null> => {
    try {
      const res = await kube.request(
        "GET",
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
      );
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      log.warn("runtime: could not check the cluster for a Service of the same name", {
        namespace,
        name,
        reason: `the API answered ${res.status}`,
      });
      return null;
    } catch (err) {
      log.warn("runtime: could not check the cluster for a Service of the same name", {
        namespace,
        name,
        reason: (err as Error).message,
      });
      return null;
    }
  };

  return [
    {
      method: "GET",
      path,
      permission: "runtime:view",
      async handle({ params }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        if (!settings) return { status: 200, body: { available: false, address: null } };
        const dir = dirOf(c);
        const files = await readDir(await atHead(repo), dir);
        const text = files.get(`${dir}/${ADDRESS_FILE}`);
        const svc = text ? servicesIn(text).find((o) => o.metadata?.name === addressServiceName(c.name)) : undefined;
        if (!svc) return { status: 200, body: { available: true, address: null } };
        const o = svc as { spec?: { clusterIP?: string; ports?: Array<{ port: number; targetPort: number }> } };
        return {
          status: 200,
          body: {
            available: true,
            address: {
              service: addressServiceName(c.name),
              clusterIP: o.spec?.clusterIP ?? null,
              address: String(svc.metadata?.annotations?.[settings.addressAnnotation] ?? ""),
              ports: (o.spec?.ports ?? []).map((p) => ({ port: p.port, targetPort: p.targetPort })),
              problems: addressPolicyProblems(svc, settings),
            },
          },
        };
      },
    },
    {
      method: "POST",
      path,
      permission: "runtime:address",
      audit: "runtime.address.add",
      async handle({ params, body, user }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        if (!settings)
          return {
            status: 409,
            body: { error: "addresses outside the cluster are not configured (runtime.external)" },
          };
        const dir = dirOf(c);
        const name = addressServiceName(c.name);
        const blocks = blocksOf(settings);
        const outside = [...(await recorded()), ...(await inCluster(settings.addressAnnotation))];
        let picked: { clusterIP: string; address: string; ports: unknown } | null = null;
        let checked = false;
        try {
          const result = await commitWithCas(repo, async (_head, at) => {
            const files = await readDir(at, dir);
            if (files.has(`${dir}/${ADDRESS_FILE}`))
              throw new Refused(409, `${c.name} has an address outside already (${dir}/${ADDRESS_FILE})`);
            const workloads = findWorkloads(files);
            if (workloads.length === 0) throw new Refused(400, `${dir} has no Deployment, StatefulSet or DaemonSet`);
            const selector = workloads[0]?.selector ?? {};
            if (Object.keys(selector).length === 0)
              throw new Refused(400, "the labels of its pods cannot be read (not plain matchLabels)");
            const ns = workloadNamespace(files, dir);
            if (typeof ns !== "string") throw new Refused(400, ns.error);
            const ports = portsOf(files, c.name, body);
            const held = await heldInRepository(at, settings.scan ?? [""], settings.addressAnnotation);
            const clash = held.services.find(
              (s) => s.service.metadata?.name === name && (s.service.metadata?.namespace ?? ns) === ns,
            );
            if (clash)
              throw new Refused(
                409,
                `${clash.path} declares a Service ${ns}/${name} already: stardust does not commit a second one of that name`,
              );
            if (!checked) {
              checked = true;
              if ((await serviceInCluster(ns, name)) === true)
                throw new Refused(
                  409,
                  `the cluster has a Service ${ns}/${name} already, which the repository does not hold: stardust does not commit a second one of that name`,
                );
            }
            const n = pickOffset(blocks, usedOffsets(blocks, [...outside, ...held.addresses]));
            if (n === null)
              throw new Refused(
                409,
                `every address from .${blocks.first} to .${blocks.last} of ${settings.addresses} is taken`,
              );
            const addresses = addressesAt(blocks, n);
            const kustomization = KUSTOMIZATIONS.map((k) => `${dir}/${k}`).find((p) => files.has(p));
            if (!kustomization) throw new Refused(400, `${dir} has no kustomization.yaml to list ${ADDRESS_FILE} in`);
            const text = renderLoadBalancer(settings, { name, namespace: ns, selector, ...addresses, ports });
            picked = { ...addresses, ports: ports.map((p) => ({ port: p.port, targetPort: p.targetPort })) };
            const out = new Map<string, string | null>([[`${dir}/${ADDRESS_FILE}`, text]]);
            const listing = files.get(kustomization) ?? "";
            out.set(kustomization, addResource(listing, ADDRESS_FILE));
            return {
              files: out,
              message: `chore(${params.project}/${c.name}): address outside ${addresses.address} (cluster IP ${addresses.clusterIP})\n\nBy ${user.username}.`,
            };
          });
          const res = answer(result, {
            projectId: params.project ?? "",
            target: c.name,
            detail: { service: name, ...(picked ?? {}) },
          });
          if (res.status === 200 && picked) res.body = { ...(res.body as object), ...(picked as object) };
          return res;
        } catch (err) {
          if (err instanceof Refused) return { status: err.status, body: { error: err.message } };
          if (err instanceof WorkloadEditError) return { status: 400, body: { error: err.message } };
          throw err;
        }
      },
    },
    {
      // Changes only the ports: the Service keeps its name, cluster IP and address, so nothing
      // that already routes to it (an edge proxy, a static route) has to change.
      method: "PUT",
      path: `${path}/ports`,
      permission: "runtime:address",
      audit: "runtime.address.ports",
      async handle({ params, body, user }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        const dir = dirOf(c);
        const name = addressServiceName(c.name);
        let changed: { from: unknown; to: unknown } | null = null;
        try {
          const result = await commitWithCas(repo, async (_head, at) => {
            const files = await readDir(at, dir);
            const file = `${dir}/${ADDRESS_FILE}`;
            const text = files.get(file);
            if (text === undefined) throw new Refused(404, `${c.name} has no address outside (${file})`);
            const ports = portsOf(files, c.name, body);
            const docs = parseAllDocuments(text);
            const doc = docs.find((d) => {
              const o =
                d.errors.length === 0 ? (d.toJS() as { kind?: string; metadata?: { name?: string } } | null) : null;
              return o?.kind === "Service" && o.metadata?.name === name;
            });
            if (!doc || !("setIn" in doc)) throw new Refused(409, `${file} does not declare the Service ${name}`);
            const before = (doc.toJS() as { spec?: { ports?: Array<{ port: number; targetPort: number }> } }).spec
              ?.ports;
            const next = ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.targetPort, protocol: "TCP" }));
            if (JSON.stringify(before ?? null) === JSON.stringify(next)) return null;
            doc.setIn(["spec", "ports"], doc.createNode(next));
            const out = docs.map((d) => d.toString({ lineWidth: 0 })).join("---\n");
            changed = {
              from: (before ?? []).map((p) => ({ port: p.port, targetPort: p.targetPort })),
              to: ports.map((p) => ({ port: p.port, targetPort: p.targetPort })),
            };
            return {
              files: new Map<string, string | null>([[file, out]]),
              message: `chore(${params.project}/${c.name}): ports of the address outside\n\nBy ${user.username}.`,
            };
          });
          return answer(result, {
            projectId: params.project ?? "",
            target: c.name,
            detail: { service: name, ...(changed ?? {}) },
          });
        } catch (err) {
          if (err instanceof Refused) return { status: err.status, body: { error: err.message } };
          if (err instanceof WorkloadEditError) return { status: 400, body: { error: err.message } };
          throw err;
        }
      },
    },
    {
      method: "DELETE",
      path,
      permission: "runtime:address",
      audit: "runtime.address.remove",
      async handle({ params, user }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        const dir = dirOf(c);
        const result = await commitWithCas(repo, async (_head, at) => {
          const files = await readDir(at, dir);
          const out = new Map<string, string | null>();
          if (files.has(`${dir}/${ADDRESS_FILE}`)) out.set(`${dir}/${ADDRESS_FILE}`, null);
          const kustomization = KUSTOMIZATIONS.map((k) => `${dir}/${k}`).find((p) => files.has(p));
          if (kustomization) {
            const listing = files.get(kustomization) ?? "";
            const next = removeResource(listing, ADDRESS_FILE);
            if (next !== listing) out.set(kustomization, next);
          }
          if (out.size === 0) return null;
          return {
            files: out,
            message: `chore(${params.project}/${c.name}): remove the address outside\n\nBy ${user.username}.`,
          };
        });
        return answer(result, {
          projectId: params.project ?? "",
          target: c.name,
          detail: { service: addressServiceName(c.name) },
        });
      },
    },
  ];
}
