/**
 * The backup CronJob's script and the restore check's, run for real in the
 * official postgres image against a seeded PostgreSQL: dump, encrypt, upload,
 * then restore into a throwaway server and compare fingerprints. Object
 * storage is a small stand-in for the aws CLI over a shared directory, so the
 * test needs Docker and network access for apk, and nothing else.
 *
 *   pnpm run test:docker
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { parse } from "yaml";
import { statefulSetPostgres } from "./statefulset.ts";

const IMAGE = "postgres:17-alpine";
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

const hasDocker = docker("version").status === 0;
const provider = statefulSetPostgres({
  kube: { request: async () => ({ status: 404, body: "" }) },
  namespace: "db",
  namespaces: [],
});
const storage = { endpoint: "https://s3.example.com", bucket: "backups", credentials: "s3", prefix: "pg" };
type Container = { env: Array<{ name: string; value?: string }>; command: string[] };
const containerOf = (files: Record<string, string>): Container => {
  const o = parse(Object.values(files)[0] ?? "") as {
    kind: string;
    spec: {
      template?: { spec: { containers: Container[] } };
      jobTemplate?: { spec: { template: { spec: { containers: Container[] } } } };
    };
  };
  const pod = o.kind === "CronJob" ? o.spec.jobTemplate?.spec.template.spec : o.spec.template?.spec;
  const c = pod?.containers[0];
  if (!c) throw new Error("no container");
  return c;
};
/** Runs a rendered container's script with its plain env, the given extra env, the fake aws first on PATH. */
const run = (c: Container, extra: Record<string, string>, mounts: string[]) =>
  docker(
    "run",
    "--rm",
    "--network",
    net,
    "-v",
    `${dir}/s3:/s3`,
    "-v",
    `${dir}/bin:/fake:ro`,
    ...mounts.flatMap((m) => ["-v", m]),
    "-e",
    "PATH=/fake:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...c.env.filter((e) => e.value !== undefined).flatMap((e) => ["-e", `${e.name}=${e.value}`]),
    ...Object.entries(extra).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    IMAGE,
    ...c.command,
  );

before(() => {
  if (!hasDocker) return;
  writeFileSync(join(dir, "aws"), FAKE_AWS);
  must(
    "run",
    "--rm",
    "-v",
    `${dir}:/d`,
    "alpine:3.20",
    "sh",
    "-c",
    "mkdir -p /d/bin /d/s3 /d/work && cp /d/aws /d/bin/aws && chmod 755 /d/bin/aws && chmod 777 /d/work",
  );
  chmodSync(join(dir, "aws"), 0o755);
  must("network", "create", net);
  must("run", "-d", "--name", source, "--network", net, "-e", "POSTGRES_PASSWORD=src-pw", IMAGE);
  // Over TCP: the image's first, initializing server listens on its socket only, then restarts.
  for (let i = 0; i < 90 && docker("exec", source, "pg_isready", "-h", "127.0.0.1", "-U", "postgres").status !== 0; i++)
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
      "postgres",
      "-q",
    ],
    {
      input: seed,
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  // An age key pair, made with the same image's packaged age.
  must(
    "run",
    "--rm",
    "-v",
    `${dir}:/d`,
    IMAGE,
    "sh",
    "-c",
    "apk add --no-cache age >/dev/null && age-keygen -o /d/identity 2>/dev/null && chmod 644 /d/identity",
  );
});

after(() => {
  if (!hasDocker) return;
  docker("rm", "-f", source);
  docker("network", "rm", net);
});

it("dumps with a fingerprint, restores the dump into a fresh server, and the fingerprints match", {
  skip: !hasDocker && "Docker is not available",
  timeout: 300_000,
}, () => {
  const recipient = /public key: (age1\w+)/.exec(readFileSync(join(dir, "identity"), "utf8"))?.[1] ?? "";
  assert.match(recipient, /^age1/);
  const backup = containerOf(
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
          superuser: { name: "s", key: "k" },
        },
      ],
    }),
  );
  const dumped = run(backup, { PW_0: "src-pw" }, []);
  assert.equal(dumped.status, 0, `${dumped.stdout}\n${dumped.stderr}`);
  assert.match(dumped.stdout, /\[done\] 1 dumps/);
  const stored = readdirSync(join(dir, "s3/backups/pg/shop-pg"));
  assert.equal(stored.filter((f) => f.endsWith(".sql.gz.age")).length, 1);
  assert.equal(stored.filter((f) => f.endsWith(".fingerprint")).length, 1);
  const dump = readFileSync(join(dir, "s3/backups/pg/shop-pg", stored.find((f) => f.endsWith(".age")) ?? ""));
  assert.ok(!dump.includes(Buffer.from("xxxxxxxxxx")), "the dump is encrypted");

  const check = containerOf(
    provider.renderRestoreCheck({
      name: "check",
      namespace: "db",
      storage,
      source: "shop-pg",
      identity: { name: "age", key: "identity" },
    }),
  );
  const mounts = [`${dir}/identity:/identity/key:ro`, `${dir}/work:/work`];
  const restored = run(check, {}, mounts);
  assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
  assert.match(restored.stdout, /\[ok\] shop-pg: .* restores, fingerprint [0-9a-f]{64}/);

  // A dump that does not restore to what was taken must fail the check.
  const fp = join(dir, "s3/backups/pg/shop-pg", stored.find((f) => f.endsWith(".fingerprint")) ?? "");
  must(
    "run",
    "--rm",
    "-v",
    `${dir}:/d`,
    "alpine:3.20",
    "sh",
    "-c",
    `echo 0000 > /d/${fp.slice(dir.length + 1)} && rm -rf /d/work/*`,
  );
  const tampered = run(check, {}, mounts);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stdout, /\[fail\] shop-pg: .* expected 0000/);
});
