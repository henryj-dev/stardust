/** The compute port on Vultr: its v2 API, as the broker lets it through. */
import {
  type ComputeCatalog,
  type ComputeInstance,
  type ComputeProvider,
  type CreateInstanceInput,
  createInstanceProblems,
} from "@stardust/core";
import { approvalClaims, signApproval } from "./approval.ts";
import type { VultrClient } from "./client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface VultrInstance {
  id: string;
  label?: string;
  hostname?: string;
  region?: string;
  plan?: string;
  os?: string;
  status?: string;
  power_status?: string;
  main_ip?: string;
  v6_main_ip?: string;
  internal_ip?: string;
  tags?: string[];
  date_created?: string;
  kvm?: string;
}

const ip = (v: string | undefined) => (v && v !== "0.0.0.0" && v !== "::" ? v : null);

export function mapInstance(v: VultrInstance): ComputeInstance {
  const state =
    v.status === "pending"
      ? "pending"
      : v.power_status === "running"
        ? "running"
        : v.power_status === "stopped"
          ? "stopped"
          : "unknown";
  return {
    id: v.id,
    label: v.label ?? "",
    hostname: v.hostname ?? "",
    region: v.region ?? "",
    plan: v.plan ?? "",
    // Vultr may leave the OS out: that is "not known", not "no OS".
    os: v.os || null,
    state,
    mainIp: ip(v.main_ip),
    ipv6: ip(v.v6_main_ip),
    internalIp: ip(v.internal_ip),
    tags: v.tags ?? [],
    createdAt: v.date_created ?? null,
  };
}

const id = (value: string) => {
  if (!UUID.test(value)) throw new Error(`not a Vultr instance id: ${value}`);
  return value;
};

export interface VultrComputeOptions {
  /** Signs the broker's delete tickets. Without a broker there is nothing to sign. */
  deleteApprovalKey?: string;
  now?: () => number;
}

export function vultrCompute(client: VultrClient, options: VultrComputeOptions = {}): ComputeProvider {
  const get = <T>(path: string) => client.request<T>({ method: "GET", path });
  return {
    capabilities: { resize: true, reverseDns: true, console: true },

    async catalog(): Promise<ComputeCatalog> {
      const [regions, plans, os, keys, vpcs] = await Promise.all([
        get<{ regions?: Array<{ id: string; city?: string; country?: string }> }>("/regions?per_page=500"),
        get<{
          plans?: Array<{
            id: string;
            vcpu_count?: number;
            ram?: number;
            disk?: number;
            monthly_cost?: number;
            locations?: string[];
          }>;
        }>("/plans?per_page=500"),
        get<{ os?: Array<{ id: number; name?: string }> }>("/os?per_page=500"),
        get<{ ssh_keys?: Array<{ id: string; name?: string }> }>("/ssh-keys?per_page=500"),
        get<{
          vpcs?: Array<{
            id: string;
            description?: string;
            region?: string;
            v4_subnet?: string;
            v4_subnet_mask?: number;
          }>;
        }>("/vpcs?per_page=500"),
      ]);
      return {
        regions: (regions.regions ?? []).map((r) => ({ id: r.id, city: r.city ?? "", country: r.country ?? "" })),
        plans: (plans.plans ?? []).map((p) => ({
          id: p.id,
          vcpus: p.vcpu_count ?? 0,
          memoryMb: p.ram ?? 0,
          diskGb: p.disk ?? 0,
          monthlyCost: p.monthly_cost ?? 0,
          regions: p.locations ?? [],
        })),
        images: (os.os ?? []).map((o) => ({ id: String(o.id), name: o.name ?? String(o.id) })),
        sshKeys: (keys.ssh_keys ?? []).map((k) => ({ id: k.id, name: k.name ?? k.id })),
        networks: (vpcs.vpcs ?? []).map((n) => ({
          id: n.id,
          name: n.description ?? n.id,
          region: n.region ?? "",
          subnet: n.v4_subnet ? `${n.v4_subnet}/${n.v4_subnet_mask ?? 0}` : null,
        })),
      };
    },

    async list() {
      const all: ComputeInstance[] = [];
      let cursor = "";
      do {
        const page = await get<{ instances?: VultrInstance[]; meta?: { links?: { next?: string } } }>(
          `/instances?per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        all.push(...(page.instances ?? []).map(mapInstance));
        cursor = page.meta?.links?.next ?? "";
      } while (cursor);
      return all;
    },

    async get(instanceId) {
      if (!UUID.test(instanceId)) return null;
      try {
        return mapInstance((await get<{ instance: VultrInstance }>(`/instances/${instanceId}`)).instance);
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },

    async create(input: CreateInstanceInput) {
      const problems = createInstanceProblems(input);
      if (problems.length > 0) throw new Error(problems.join("; "));
      const made = await client.request<{ instance: VultrInstance }>({
        method: "POST",
        path: "/instances",
        body: {
          region: input.region,
          plan: input.plan,
          os_id: Number(input.image),
          label: input.label,
          hostname: input.hostname,
          ...(input.sshKeys?.length ? { sshkey_id: input.sshKeys } : {}),
          ...(input.userData !== undefined
            ? { user_data: Buffer.from(input.userData, "utf8").toString("base64") }
            : {}),
          ...(input.networks?.length ? { attach_vpc: input.networks } : {}),
          ...(input.tags?.length ? { tags: input.tags } : {}),
        },
      });
      return mapInstance(made.instance);
    },

    async resize(instanceId, plan) {
      await client.request({ method: "PATCH", path: `/instances/${id(instanceId)}`, body: { plan } });
    },

    async clearUserData(instanceId, note) {
      const placeholder = `#cloud-config\n# user data cleared after the instance came up: ${note.replace(/[\r\n]/g, " ")}\n`;
      await client.request({
        method: "PATCH",
        path: `/instances/${id(instanceId)}`,
        body: { user_data: Buffer.from(placeholder, "utf8").toString("base64") },
      });
    },

    async setReverseDns(instanceId, address, name) {
      const family = address.includes(":") ? "ipv6" : "ipv4";
      await client.request({
        method: "POST",
        path: `/instances/${id(instanceId)}/${family}/reverse`,
        body: { ip: address, reverse: name },
      });
    },

    async console(instanceId) {
      if (!UUID.test(instanceId)) return null;
      return (await get<{ instance: VultrInstance }>(`/instances/${instanceId}`)).instance.kvm ?? null;
    },

    async destroy(instanceId, approvedBy) {
      if (!approvedBy) throw new Error("deleting an instance needs who approved it");
      const target = id(instanceId);
      // A ticket for this instance only, for a few minutes, used once: the broker checks it.
      const headers = options.deleteApprovalKey
        ? {
            "x-delete-approval": signApproval(
              approvalClaims(target, approvedBy, options.now?.() ?? Date.now()),
              options.deleteApprovalKey,
            ),
          }
        : undefined;
      await client.request({ method: "DELETE", path: `/instances/${target}`, ...(headers ? { headers } : {}) });
    },
  };
}
