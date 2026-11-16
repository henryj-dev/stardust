/**
 * The backup CronJob and the restore check, run for real step by step: each
 * rendered container runs in its own image (postgres, sops, aws-cli) as the
 * user the pod asks for, the steps of one pod sharing a host directory as
 * /work, against a seeded PostgreSQL. Object storage is a small stand-in for
 * the aws CLI over a shared directory, mounted over the image's `aws`, so the
 * steps' shell runs unchanged. The source is made with POSTGRES_USER, so
 * its superuser is not named postgres. The age key is made here, at run
 * time. Needs Docker and nothing else.
 *
 *   pnpm run test:docker
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { parse } from "yaml";
import { statefulSetPostgres } from "./statefulset.ts";

const PG_IMAGE = "postgres:17-alpine";
// The source is made with POSTGRES_USER: no role named postgres exists there.
const SUPERUSER = "appowner";
const id = `sdbk${process.pid}`;
const net = `${id}-net`;
const source = `${id}-src`;
const dir = mkdtempSync(join(tmpdir(), "stardust-backup-"));
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const must = (...args: string[]) => {
  const r = docker(...args);
  assert.equal(r.status, 0, `docker ${args.slice(0, 3).join(" ")}: ${r.stderr}`);
  return r.stdout;
};

// The aws CLI, as far as the scripts use it, over /s3/<bucket>/<key>.
const FAKE_AWS = String.raw`#!/bin/sh
set -eu
while [ "$1" != s3api ]; do shift; done; shift
OP="$1"; shift
B=""; K=""; BODY=""; P=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bucket) B="$2"; shift 2;; --key) K="$2"; shift 2;; --body) BODY="$2"; shift 2;;
    --prefix) P="$2"; shift 2;; --query|--output) shift 2;; *) OUT="$1"; shift;;
  esac
done
case "$OP" in
  put-object) mkdir -p "$(dirname "/s3/$B/$K")"; cp "$BODY" "/s3/$B/$K";;
  head-object) stat -c%s "/s3/$B/$K";;
  get-object) [ -f "/s3/$B/$K" ] || exit 254; cp "/s3/$B/$K" "$OUT";;
  delete-object) rm -f "/s3/$B/$K";;
  list-objects-v2) (cd "/s3/$B" 2>/dev/null && find . -type f | sed 's|^\./||' | grep "^$P" | sort | tr '\n' '\t') || true; echo;;
  *) echo "fake aws: $OP" >&2; exit 2;;
esac
`;

// An age key pair: X25519 keys in bech32, as age-keygen writes them.
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32(hrp: string, bytes: Buffer): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const polymod = (values: number[]) => {
    const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i] ?? 0;
    }
    return chk;
  };
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  const expanded = [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...check].map((w) => BECH32[w]).join("")}`;
}
function ageKeyPair(): { recipient: string; identity: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d ?? "", "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  return { recipient: bech32("age", x), identity: bech32("age-secret-key-", d).toUpperCase() };
}

const hasDocker = docker("version").status === 0;
const provider = statefulSetPostgres({
  kube: { request: async () => ({ status: 404, body: "" }) },
  namespace: "db",
  namespaces: [],
});
const storage = { endpoint: "https://s3.example.com", bucket: "backups", credentials: "s3", prefix: "pg" };
type Container = { name: string; image: string; env: Array<{ name: string; value?: string }>; command: string[] };
type Pod = {
  securityContext: { runAsUser: number; runAsGroup: number };
  initContainers?: Container[];
  containers: Container[];
};
const podOf = (files: Record<string, string>): Pod => {
  const o = parse(Object.values(files)[0] ?? "") as {
    kind: string;
    spec: { template?: { spec: Pod }; jobTemplate?: { spec: { template: { spec: Pod } } } };
  };
  const pod = o.kind === "CronJob" ? o.spec.jobTemplate?.spec.template.spec : o.spec.template?.spec;
  if (!pod) throw new Error("no pod");
  return pod;
};
const stepsOf = (pod: Pod) => [...(pod.initContainers ?? []), ...pod.containers];

/** A fresh directory for one pod's /work (an emptyDir), writable by the pod's user. */
let pods = 0;
const workDir = () => {
  const w = join(dir, `work-${pods++}`);
  mkdirSync(w);
  chmodSync(w, 0o777);
  return w;
};

/**
 * Runs a pod's steps in order like the kubelet: init containers, then the
 * container, stopping at the first failure. Secret env comes from `secrets`;
 * the identity Secret from `identity` when a step mounts it.
 */
function runPod(pod: Pod, secrets: Record<string, string>, identity?: string) {
  const work = workDir();
  const user = `${pod.securityContext.runAsUser}:${pod.securityContext.runAsGroup}`;
  let out = "";
  for (const c of stepsOf(pod)) {
    const mounts = [`${work}:/work`, `${dir}/s3:/s3`];
    if (c.image.includes("amazon/aws-cli")) mounts.push(`${dir}/aws:/usr/local/bin/aws:ro`);
    const mountsIdentity = (c as { volumeMounts?: Array<{ name: string }> }).volumeMounts?.some(
      (m) => m.name === "identity",
    );
    if (mountsIdentity && identity) mounts.push(`${identity}:/identity/key:ro`);
    const r = docker(
      "run",
      "--rm",
      "--network",
      net,
      "--user",
      user,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...mounts.flatMap((m) => ["-v", m]),
      ...c.env.flatMap((e) => ["-e", `${e.name}=${e.value ?? secrets[e.name] ?? ""}`]),
      "--entrypoint",
      c.command[0] ?? "",
      c.image,
      ...c.command.slice(1),
    );
    out += `--- ${c.name}\n${r.stdout}${r.stderr}`;
    if (r.status !== 0) return { status: r.status, out, failed: c.name, work };
  }
  return { status: 0, out, failed: null, work };
}

before(() => {
  if (!hasDocker) return;
  writeFileSync(join(dir, "aws"), FAKE_AWS);
  chmodSync(join(dir, "aws"), 0o755);
  mkdirSync(join(dir, "s3"));
  chmodSync(join(dir, "s3"), 0o777);
  must("network", "create", net);
  must(
    "run",
    "-d",
    "--name",
    source,
    "--network",
    net,
    "-e",
    "POSTGRES_PASSWORD=src-pw",
    "-e",
    `POSTGRES_USER=${SUPERUSER}`,
    PG_IMAGE,
  );
  // Over TCP: the image's first, initializing server listens on its socket only, then restarts.
  for (let i = 0; i < 90 && docker("exec", source, "pg_isready", "-h", "127.0.0.1", "-U", SUPERUSER).status !== 0; i++)
    spawnSync("sleep", ["1"]);
  const seed = [
    "CREATE DATABASE shop;",
    "\\c shop",
    "CREATE TABLE orders (id int primary key, note text); INSERT INTO orders SELECT g, repeat('x', 200) FROM generate_series(1, 500) g;",
    "CREATE SCHEMA app; CREATE TABLE app.items (id int); INSERT INTO app.items SELECT generate_series(1, 42);",
  ].join("\n");
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGPASSWORD=src-pw",
      source,
      "psql",
      "-h",
      "127.0.0.1",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      SUPERUSER,
      "-q",
    ],
    { input: seed, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const roles = must(
    "exec",
    source,
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    SUPERUSER,
    "-d",
    "postgres",
    "-Atc",
    "SELECT count(*) FROM pg_roles WHERE rolname = 'postgres'",
  );
  assert.equal(roles.trim(), "0", "the source has no postgres role");
});

after(() => {
  if (!hasDocker) return;
  docker("rm", "-f", source);
  docker("network", "rm", net);
  // Files the steps wrote belong to their user; remove them as root.
  docker("run", "--rm", "-v", `${dir}:/d`, PG_IMAGE, "sh", "-c", "rm -rf /d/s3 /d/work-*");
});

it("dumps with a fingerprint, restores the dump into a fresh server, and the fingerprints match", {
  skip: !hasDocker && "Docker is not available",
  timeout: 600_000,
}, () => {
  const { recipient, identity } = ageKeyPair();
  assert.match(recipient, /^age1[0-9a-z]{58}$/);
  const identityFile = join(dir, "identity");
  writeFileSync(identityFile, `${identity}\n`);
  chmodSync(identityFile, 0o644);

  const backup = podOf(
    provider.renderBackup({
      name: "db-backup",
      namespace: "db",
      schedule: "15 3 * * *",
      storage,
      recipient,
      retentionHours: 24,
      targets: [
        {
          name: "shop-pg",
          ref: { namespace: "db", name: "shop-pg" },
          host: source,
          superuser: { name: "s", key: "k", role: SUPERUSER },
        },
      ],
    }),
  );
  const s3Secrets = { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" };
  const dumped = runPod(backup, { ...s3Secrets, PW_0: "src-pw" });
  assert.equal(dumped.status, 0, dumped.out);
  assert.match(dumped.out, /\[done\] 1 dumps/);
  assert.deepEqual(
    readdirSync(dumped.work).sort(),
    ["shop-pg.fingerprint", "shop-pg.sql.gz.sops.json"],
    "no plain dump is left behind",
  );
  const stored = readdirSync(join(dir, "s3/backups/pg/shop-pg"));
  assert.equal(stored.filter((f) => /^dumpall-\d{8}-\d{6}\.sql\.gz\.sops\.json$/.test(f)).length, 1);
  assert.equal(stored.filter((f) => f.endsWith(".fingerprint")).length, 1);
  const dump = readFileSync(join(dir, "s3/backups/pg/shop-pg", stored.find((f) => f.endsWith(".sops.json")) ?? ""));
  assert.ok(!dump.includes(Buffer.from("xxxxxxxxxx")), "the dump is encrypted");
  assert.match(dump.toString("utf8"), /"age"/, "to the age recipient");

  const check = podOf(
    provider.renderRestoreCheck({
      name: "check",
      namespace: "db",
      storage,
      source: "shop-pg",
      identity: { name: "age", key: "identity" },
    }),
  );
  const restored = runPod(check, s3Secrets, identityFile);
  assert.equal(restored.status, 0, restored.out);
  assert.match(restored.out, /\[ok\] shop-pg: .* restores, fingerprint [0-9a-f]{64}/);

  // A dump that does not restore to what was taken must fail the check.
  const fp = stored.find((f) => f.endsWith(".fingerprint")) ?? "";
  must("run", "--rm", "-v", `${dir}/s3:/s3`, PG_IMAGE, "sh", "-c", `echo 0000 > /s3/backups/pg/shop-pg/${fp}`);
  const tampered = runPod(check, s3Secrets, identityFile);
  assert.notEqual(tampered.status, 0);
  assert.equal(tampered.failed, "restore-check");
  assert.match(tampered.out, /\[fail\] shop-pg: .* expected 0000/);

  // Without the identity, the decrypt step fails and the check never runs.
  const noKey = runPod(check, s3Secrets);
  assert.equal(noKey.failed, "decrypt", noKey.out);
});
