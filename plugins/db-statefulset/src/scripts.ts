/**
 * The shell each step of the backup and restore check runs. Every step runs
 * in one official image, with nothing installed at run time, and the steps
 * of one pod pass files through an emptyDir at /work:
 *
 *   backup:        dump (postgres) -> encrypt (sops) -> upload (aws-cli)
 *   restore check: fetch (aws-cli) -> decrypt (sops) -> check (postgres)
 *
 * A fingerprint is the sorted list of every connectable database and the
 * exact row count of each of its tables, hashed. The backup takes one of each
 * source just before its dump and stores it beside the dump; a restore check
 * restores the dump into a throwaway server and must arrive at the same one.
 * Counts are a cheap, table-agnostic witness: a restore that lost a table or
 * its rows does not match. Writes between the fingerprint and the dump can
 * make an honest dump differ, so check a quiet instance (or accept a retry).
 *
 * Target names are Kubernetes names, so they appear unquoted.
 */

/** `fingerprint HOST USER` prints the hash; PGPASSWORD is read from the environment. */
export const FINGERPRINT_FUNCTION = String.raw`fingerprint() {
  psql -h "$1" -U "$2" -d postgres -Atq -v ON_ERROR_STOP=1 \
    -c "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname" |
  while IFS= read -r D; do
    printf 'database:%s\n' "$D"
    # A session-local function in pg_temp: PostgreSQL has no CREATE TEMP FUNCTION,
    # and a statement that fails without ON_ERROR_STOP would hash an empty list.
    psql -h "$1" -U "$2" -d "$D" -Atq -v ON_ERROR_STOP=1 <<'SQL'
CREATE FUNCTION pg_temp.stardust_counts() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE r record; n bigint;
BEGIN
  FOR r IN SELECT ns.nspname, c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'p') AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
             AND ns.nspname NOT LIKE 'pg_toast%' ORDER BY 1, 2 LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', r.nspname, r.relname) INTO n;
    RETURN NEXT format('%s.%s:%s', r.nspname, r.relname, n);
  END LOOP;
END $fn$;
SELECT pg_temp.stardust_counts();
SQL
  done | LC_ALL=C sort | sha256sum | cut -d' ' -f1
}`;

/** The suffix of an encrypted dump; its fingerprint sits beside it as `.fingerprint`. */
export const DUMP_SUFFIX = ".sql.gz.sops.json";

const count = (counter: string, n: number, what: string) =>
  `[ "$${counter}" -eq ${n} ] || { echo "[fail] $${counter} of ${n} ${what}"; exit 1; }`;

/**
 * Backup step 1, postgres image: a fingerprint and a gzipped pg_dumpall of
 * each target into /work/<name>.{fingerprint,sql.gz}. Env: each target's
 * password env.
 */
export function dumpScript(targets: ReadonlyArray<{ name: string; host: string; passwordEnv: string }>): string {
  const calls = targets.map((t) => `dump_one ${t.name} ${t.host} "$${t.passwordEnv}"`).join("\n");
  return `set -eu
set -o pipefail
DUMPED=0
${FINGERPRINT_FUNCTION}
dump_one() {
  NAME="$1"; HOST="$2"; export PGPASSWORD="$3"
  fingerprint "$HOST" postgres > "/work/$NAME.fingerprint"
  pg_dumpall --clean --if-exists -h "$HOST" -U postgres | gzip -9 > "/work/$NAME.sql.gz"
  SIZE="$(stat -c%s "/work/$NAME.sql.gz")"
  # A pipe can quietly carry nothing: refuse a dump too small to hold a cluster.
  [ "$SIZE" -gt 1000 ] || { echo "[fail] $NAME: the dump is only $SIZE bytes"; exit 1; }
  DUMPED=$((DUMPED + 1))
  echo "[ok] $NAME dumped ($SIZE bytes)"
}
${calls}
${count("DUMPED", targets.length, "dumps")}`;
}

/**
 * Backup step 2, sops image: encrypts each dump to the age recipient and
 * removes the plain one. A rerun skips what is already encrypted. Env: RECIPIENT.
 */
export function encryptScript(names: readonly string[]): string {
  return `set -eu
set -o pipefail
ENCRYPTED=0
encrypt_one() {
  F="/work/$1.sql.gz"
  if [ -f "$F" ]; then
    sops encrypt --age "$RECIPIENT" --input-type binary --output-type json "$F" > "$F.sops.tmp"
    mv "$F.sops.tmp" "$F.sops.json"
    rm -f "$F"
  fi
  [ -s "$F.sops.json" ] || { echo "[fail] $1: nothing encrypted"; exit 1; }
  ENCRYPTED=$((ENCRYPTED + 1))
  echo "[ok] $1 encrypted"
}
${names.map((n) => `encrypt_one ${n}`).join("\n")}
${count("ENCRYPTED", names.length, "dumps encrypted")}`;
}

/**
 * Backup step 3, aws-cli image: uploads each encrypted dump and its
 * fingerprint, reads the stored sizes back, then prunes old dumps.
 * Env: ENDPOINT BUCKET PREFIX RETENTION_HOURS and the AWS credentials.
 */
export function uploadScript(names: readonly string[]): string {
  return String.raw`set -eu
set -o pipefail
STAMP="$(date -u +%Y%m%d-%H%M%S)"
S3="aws --endpoint-url $ENDPOINT s3api"
UPLOADED=0
put() { # $1=key $2=file: upload, then read the stored size back (a write's success is not proof)
  $S3 put-object --bucket "$BUCKET" --key "$1" --body "$2" >/dev/null
  REMOTE="$($S3 head-object --bucket "$BUCKET" --key "$1" --query ContentLength --output text)"
  [ "$REMOTE" = "$(stat -c%s "$2")" ] || { echo "[fail] $1: stored $REMOTE bytes of $(stat -c%s "$2")"; exit 1; }
}
upload_one() {
  NAME="$1"
  BASE="$PREFIX/$NAME/dumpall-$STAMP"
  F="/work/$NAME${DUMP_SUFFIX}"
  SIZE="$(stat -c%s "$F")"
  [ "$SIZE" -gt 1000 ] || { echo "[fail] $NAME: the encrypted dump is only $SIZE bytes"; exit 1; }
  put "$BASE${DUMP_SUFFIX}" "$F"
  put "$BASE.fingerprint" "/work/$NAME.fingerprint"
  UPLOADED=$((UPLOADED + 1))
  echo "[ok] $NAME -> $BASE${DUMP_SUFFIX} ($SIZE bytes)"
}
${names.map((n) => `upload_one ${n}`).join("\n")}
${count("UPLOADED", names.length, "dumps")}
# Prune by comparing timestamps in the shell: a JMESPath string comparison would silently match nothing.
# Older .sql.gz.age dumps are pruned the same way.
CUT="$(date -u -d @"$(( $(date -u +%s) - RETENTION_HOURS * 3600 ))" +%Y%m%d%H%M%S)"
$S3 list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/" --query 'Contents[].Key' --output text | tr '\t' '\n' |
while read -r K; do
  T="$(echo "$K" | grep -oE 'dumpall-[0-9]{8}-[0-9]{6}\.(sql\.gz\.sops\.json|sql\.gz\.age|fingerprint)$' | tr -dc 0-9 || true)"
  if [ -n "$T" ] && [ "$T" -lt "$CUT" ]; then $S3 delete-object --bucket "$BUCKET" --key "$K" >/dev/null; echo "[pruned] $K"; fi
done
echo "[done] $UPLOADED dumps"`;
}

/**
 * Restore check step 1, aws-cli image: the newest dump of SOURCE and its
 * fingerprint into /work. Env: ENDPOINT BUCKET PREFIX SOURCE and the AWS credentials.
 */
export function fetchScript(): string {
  const suffix = DUMP_SUFFIX.replace(/\./g, "\\.");
  return String.raw`set -eu
set -o pipefail
S3="aws --endpoint-url $ENDPOINT s3api"
fail() { echo "[fail] $SOURCE: $1"; exit 1; }
LATEST="$($S3 list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/$SOURCE/" --query 'Contents[].Key' --output text | tr '\t' '\n' |
  grep -E '/dumpall-[0-9]{8}-[0-9]{6}${suffix}$' | sort | tail -1 || true)"
[ -n "$LATEST" ] || fail "no dump under $PREFIX/$SOURCE/"
$S3 get-object --bucket "$BUCKET" --key "$LATEST" /work/dump${DUMP_SUFFIX} >/dev/null
$S3 get-object --bucket "$BUCKET" --key "${"$"}{LATEST%${DUMP_SUFFIX}}.fingerprint" /work/expected >/dev/null || fail "no fingerprint beside $LATEST"
printf '%s\n' "$LATEST" > /work/latest
echo "[ok] $SOURCE: fetched $LATEST"`;
}

/** Restore check step 2, sops image: decrypts the dump. Env: SOPS_AGE_KEY_FILE. */
export function decryptScript(): string {
  return `set -eu
sops decrypt --input-type json --output-type binary /work/dump${DUMP_SUFFIX} > /work/dump.sql.gz
echo "[ok] decrypted"`;
}

/**
 * Restore check step 3, postgres image as its own user: restores the dump
 * into a throwaway server on a socket in /work and compares fingerprints;
 * exits 0 only when they match. Env: SOURCE.
 */
export function checkScript(): string {
  return `set -eu
set -o pipefail
${FINGERPRINT_FUNCTION}
LATEST="$(cat /work/latest)"
initdb -D /work/pg -U restoreadmin --auth=trust >/dev/null
pg_ctl -D /work/pg -o "-c listen_addresses='' -k /work" -w start >/dev/null
trap 'pg_ctl -D /work/pg -m fast stop >/dev/null 2>&1 || true' EXIT
gunzip -c /work/dump.sql.gz | psql -v ON_ERROR_STOP=1 -q -h /work -U restoreadmin -d postgres >/dev/null
GOT="$(PGPASSWORD= fingerprint /work restoreadmin)"
WANT="$(cat /work/expected)"
if [ "$GOT" = "$WANT" ]; then echo "[ok] $SOURCE: $LATEST restores, fingerprint $GOT"; else echo "[fail] $SOURCE: $LATEST restores to $GOT, expected $WANT"; exit 1; fi`;
}
