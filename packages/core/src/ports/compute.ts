/**
 * Cloud instances, as the `instances` feature sees them: what can be made
 * (regions, plans, images, keys, private networks), the instances there are,
 * and the few changes stardust makes to them. Several accounts or providers
 * can be configured at once, each by its own name.
 *
 * Deleting names who approved it. The feature checks that a person confirmed
 * this one deletion before it asks; a provider behind a broker turns the
 * approval into the proof the broker wants (a signed, short-lived ticket for
 * this instance only).
 */

export type InstanceState = "pending" | "running" | "stopped" | "unknown";

export interface ComputeInstance {
  id: string;
  label: string;
  hostname: string;
  region: string;
  plan: string;
  /** The image's name, or null when the provider does not say. */
  os: string | null;
  state: InstanceState;
  mainIp: string | null;
  ipv6: string | null;
  /** On a private network, when attached to one. */
  internalIp: string | null;
  tags: string[];
  createdAt: string | null;
}

export interface ComputeCatalog {
  regions: Array<{ id: string; city: string; country: string }>;
  plans: Array<{ id: string; vcpus: number; memoryMb: number; diskGb: number; monthlyCost: number; regions: string[] }>;
  images: Array<{ id: string; name: string }>;
  sshKeys: Array<{ id: string; name: string }>;
  networks: Array<{ id: string; name: string; region: string; subnet: string | null }>;
}

export interface CreateInstanceInput {
  label: string;
  hostname: string;
  region: string;
  plan: string;
  /** An image id from the catalog. */
  image: string;
  sshKeys?: string[];
  /** cloud-init. It can hold bootstrap secrets: clear it once the instance is up. */
  userData?: string;
  networks?: string[];
  tags?: string[];
}

export interface ComputeProvider {
  readonly capabilities: { resize: boolean; reverseDns: boolean; console: boolean };
  catalog(): Promise<ComputeCatalog>;
  list(): Promise<ComputeInstance[]>;
  /** Null when there is no such instance. */
  get(id: string): Promise<ComputeInstance | null>;
  create(input: CreateInstanceInput): Promise<ComputeInstance>;
  resize?(id: string, plan: string): Promise<void>;
  /** Replaces the user data with a note, so bootstrap secrets do not stay readable. */
  clearUserData(id: string, note: string): Promise<void>;
  setReverseDns?(id: string, ip: string, name: string): Promise<void>;
  /** A URL to the instance's console, when the provider has one. */
  console?(id: string): Promise<string | null>;
  /** Refuses without the name of who approved it. */
  destroy(id: string, approvedBy: string): Promise<void>;
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Why an instance cannot be asked for, or nothing. Checked before any provider sees it. */
export function createInstanceProblems(input: CreateInstanceInput): string[] {
  const problems: string[] = [];
  if (!LABEL.test(input.label)) problems.push("label must be letters, digits, spaces, dots, dashes or underscores");
  if (!HOST.test(input.hostname) || input.hostname.length > 253) problems.push("hostname must be a host name");
  for (const [field, value] of [
    ["region", input.region],
    ["plan", input.plan],
    ["image", input.image],
  ] as const) {
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value))
      problems.push(`${field} must be an id from the catalog`);
  }
  if (input.userData !== undefined && Buffer.byteLength(input.userData) > 64 * 1024)
    problems.push("userData must be at most 64 KiB");
  for (const tag of input.tags ?? []) if (!/^[A-Za-z0-9:._-]{1,64}$/.test(tag)) problems.push(`not a tag: ${tag}`);
  return problems;
}
