/**
 * Secret files on a component's page (see @stardust/core gitops/secret-files):
 * sets of keys sealed with the cipher, mounted at /run/secrets/<set>/<key>.
 * Generating, uploading, replacing and deleting a key is an administrator's
 * (`runtime:secrets`) and audited; a value is never returned, logged or
 * written to the audit log, only the set and key names.
 */
import { randomBytes } from "node:crypto";
import {
  addResource,
  commitWithCas,
  isSecretKey,
  isSecretSetName,
  type RepoIO,
  type Route,
  type RouteResponse,
  readDirectoryWorkload,
  readSecretMounts,
  removeResource,
  type SecretCipher,
  secretKeysOf,
  secretSetDocument,
  secretSetFile,
  secretSetOf,
  secretSetPath,
  secretSetSecretName,
  secretValuesOf,
  setSecretMounts,
  WorkloadEditError,
  workloadNamespace,
} from "@stardust/core";
import { answer, atHead, type ComponentRef, dirOf, readDir } from "./settings.ts";

/** At most this many bytes in one value; a Secret holds at most 1 MiB in all. */
export const MAX_VALUE_BYTES = 256 * 1024;
const ENCODINGS = ["raw", "base64", "hex"] as const;
type Encoding = (typeof ENCODINGS)[number];

const KUSTOMIZATIONS = ["kustomization.yaml", "kustomization.yml"];
const isOwnFile = (path: string) => /\.enc\.ya?ml$/.test(path) || /\/env\.[^/]+$/.test(path);

/** A value to put under a key: generated here, or uploaded (base64 in the body). */
export function valueFrom(body: unknown): { value: Buffer; how: Record<string, unknown> } {
  const b = (body ?? {}) as { generate?: unknown; value?: unknown };
  if ((b.generate === undefined) === (b.value === undefined))
    throw new WorkloadEditError("give either generate: { bytes } or value (base64)");
  if (b.generate !== undefined) {
    const { bytes, encoding = "raw", ...rest } = (b.generate ?? {}) as { bytes?: unknown; encoding?: unknown };
    if (Object.keys(rest).length > 0) throw new WorkloadEditError("generate takes bytes and encoding");
    if (!Number.isInteger(bytes) || (bytes as number) < 16 || (bytes as number) > 4096)
      throw new WorkloadEditError("generate.bytes must be 16-4096");
    if (!(ENCODINGS as readonly unknown[]).includes(encoding))
      throw new WorkloadEditError("generate.encoding must be raw, base64 or hex");
    const raw = randomBytes(bytes as number);
    const value = encoding === "raw" ? raw : Buffer.from(raw.toString(encoding === "hex" ? "hex" : "base64"), "utf8");
    return { value, how: { generated: { bytes, encoding: encoding as Encoding } } };
  }
  if (typeof b.value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.value) || b.value.length % 4 !== 0)
    throw new WorkloadEditError("value must be base64");
  const value = Buffer.from(b.value, "base64");
  if (value.length === 0) throw new WorkloadEditError("value is empty");
  if (value.length > MAX_VALUE_BYTES) throw new WorkloadEditError(`value is larger than ${MAX_VALUE_BYTES} bytes`);
  return { value, how: { uploaded: { bytes: value.length } } };
}

export function secretFileRoutes(input: {
  repo: RepoIO;
  cipher: Pick<SecretCipher, "decrypt" | "encryptIfChanged"> | undefined;
  component: (params: Readonly<Record<string, string>>) => Promise<ComponentRef | null>;
}): Route[] {
  const { repo, cipher, component } = input;
  const base = "/projects/:project/components/:component/secret-files";

  /**
   * One commit that sets (or, with null, removes) one key of one set: the
   * sealed Secret, the mounts in every workload, and the kustomization entry.
   */
  const change = async (
    params: Readonly<Record<string, string>>,
    user: { username: string },
    op: "create" | "replace" | "delete",
    value: Buffer | null,
    detail: Record<string, unknown>,
  ): Promise<RouteResponse> => {
    if (!cipher) return { status: 404, body: { error: "secret files need a cipher (secrets-sops-age) to seal them" } };
    const c = await component(params);
    if (!c) return { status: 404, body: { error: "unknown component" } };
    const set = params.set ?? "";
    const key = params.key ?? "";
    if (!isSecretSetName(set))
      return { status: 400, body: { error: "the set must be lower-case letters, digits and dashes (at most 24)" } };
    if (!isSecretKey(key))
      return { status: 400, body: { error: "the key must be letters, digits, '.', '_' or '-' (a file name)" } };
    const dir = dirOf(c);
    let conflict: string | null = null;
    try {
      const result = await commitWithCas(repo, async (_head, at) => {
        conflict = null;
        const files = await readDir(at, dir);
        const path = `${dir}/${secretSetFile(set)}`;
        const current = files.get(path) ?? null;
        const keys = current ? secretKeysOf(current) : [];
        if (op === "create" && keys.includes(key)) {
          conflict = `${set}/${key} exists already: replace it on purpose, the old value is then gone`;
          return null;
        }
        if (op !== "create" && !keys.includes(key)) {
          conflict = `${set} has no key ${key}`;
          return null;
        }
        const out = new Map<string, string | null>();
        const values = current ? secretValuesOf(await cipher.decrypt(current)) : {};
        if (value) values[key] = value;
        else delete values[key];
        const keep = Object.keys(values).length > 0;
        if (keep) {
          const ns = workloadNamespace(files, dir);
          if (typeof ns !== "string") throw new WorkloadEditError(ns.error);
          const plain = secretSetDocument({ component: c.name, namespace: ns, name: set, data: values });
          const sealed = await cipher.encryptIfChanged(current, plain);
          if (sealed.changed || !current) out.set(path, sealed.document);
        } else {
          out.set(path, null);
        }
        // Every set the directory will hold, mounted in every workload.
        const sets = new Set<string>();
        for (const p of files.keys()) {
          const s = secretSetOf(p);
          if (s && (s !== set || keep)) sets.add(s);
        }
        if (keep) sets.add(set);
        let workloads = 0;
        for (const [p, text] of files) {
          if (isOwnFile(p) || KUSTOMIZATIONS.some((k) => p.endsWith(`/${k}`))) continue;
          let edited: ReturnType<typeof setSecretMounts>;
          try {
            edited = setSecretMounts(text, { component: c.name, sets: [...sets] });
          } catch (err) {
            throw new WorkloadEditError(`${p}: ${(err as Error).message}`);
          }
          workloads += edited.workloads;
          if (edited.changed) out.set(p, edited.text);
        }
        if (workloads === 0) throw new WorkloadEditError(`${dir} has no Deployment, StatefulSet or DaemonSet`);
        const kustomization = KUSTOMIZATIONS.map((k) => `${dir}/${k}`).find((p) => files.has(p));
        if (!kustomization)
          throw new WorkloadEditError(`${dir} has no kustomization.yaml to list ${secretSetFile(set)} in`);
        const listing = files.get(kustomization) ?? "";
        const next = keep ? addResource(listing, secretSetFile(set)) : removeResource(listing, secretSetFile(set));
        if (next !== listing) out.set(kustomization, next);
        const verb = { create: "add", replace: "replace", delete: "delete" }[op];
        return {
          files: out,
          message: `chore(${params.project}/${c.name}): ${verb} secret file ${set}/${key}\n\nBy ${user.username}.`,
        };
      });
      if (conflict) return { status: 409, body: { error: conflict } };
      return answer(result, {
        projectId: params.project ?? "",
        target: c.name,
        detail: { set, key, ...detail },
      });
    } catch (err) {
      if (err instanceof WorkloadEditError) return { status: 400, body: { error: err.message } };
      throw err;
    }
  };

  const withValue =
    (op: "create" | "replace"): Route["handle"] =>
    async ({ params, body, user }) => {
      let v: ReturnType<typeof valueFrom>;
      try {
        v = valueFrom(body);
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
      return change(params, user, op, v.value, v.how);
    };

  return [
    {
      method: "GET",
      path: base,
      permission: "runtime:view",
      async handle({ params }) {
        const c = await component(params);
        if (!c) return { status: 404, body: { error: "unknown component" } };
        const dir = dirOf(c);
        const files = await readDir(await atHead(repo), dir);
        const mounted = new Set<string>();
        for (const [p, text] of files) {
          if (isOwnFile(p)) continue;
          try {
            for (const s of readSecretMounts(text, c.name)) mounted.add(s);
          } catch {
            // An unparseable manifest mounts nothing stardust can tell.
          }
        }
        const sets = [];
        for (const [p, text] of files) {
          const name = secretSetOf(p);
          if (!name) continue;
          sets.push({
            name,
            secret: secretSetSecretName(c.name, name),
            path: secretSetPath(name),
            keys: secretKeysOf(text),
            mounted: mounted.has(name),
          });
        }
        return {
          status: 200,
          body: {
            available: Boolean(cipher),
            fsGroup: readDirectoryWorkload(files, c.name).settings?.fsGroup ?? null,
            sets: sets.sort((a, b) => a.name.localeCompare(b.name)),
          },
        };
      },
    },
    {
      method: "POST",
      path: `${base}/:set/keys/:key`,
      permission: "runtime:secrets",
      audit: "runtime.secret-files.add",
      handle: withValue("create"),
    },
    {
      method: "PUT",
      path: `${base}/:set/keys/:key`,
      permission: "runtime:secrets",
      audit: "runtime.secret-files.replace",
      // The old value is gone for good.
      fresh: true,
      handle: withValue("replace"),
    },
    {
      method: "DELETE",
      path: `${base}/:set/keys/:key`,
      permission: "runtime:secrets",
      audit: "runtime.secret-files.delete",
      fresh: true,
      handle: ({ params, user }) => change(params, user, "delete", null, {}),
    },
  ];
}
