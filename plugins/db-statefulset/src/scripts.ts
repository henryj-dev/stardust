/**
 * The shell the engine's Jobs run, in the official postgres alpine image
 * (busybox ash). Tools come from the distribution's signed repository only.
 *
 * A fingerprint is the sorted list of every connectable database and the
 * exact row count of each of its tables, hashed. The backup takes one of each
 * source just before its dump and stores it beside the dump; a restore check
 * restores the dump into a throwaway server and must arrive at the same one.
 * Counts are a cheap, table-agnostic witness: a restore that lost a table or
 * its rows does not match. Writes between the fingerprint and the dump can
 * make an honest dump differ, so check a quiet instance (or accept a retry).
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

/** Every dump of every target, and the count it must reach. Env: ENDPOINT BUCKET PREFIX RECIPIENT RETENTION_HOURS, and each target's password env. */
export function backupScript(targets: ReadonlyArray<{ name: string; host: string; passwordEnv: string }>): string {
  const calls = targets.map((t) => `dump_one ${t.name} ${t.host} "$${t.passwordEnv}"`).join("\n");
  return String.raw`set -eu
set -o pipefail
apk add --no-cache aws-cli age >/dev/null
STAMP="$(date -u +%Y%m%d-%H%M%S)"
S3="aws --endpoint-url $ENDPOINT s3api"
UPLOADED=0
${FINGERPRINT_FUNCTION}
put() { # $1=key $2=file: upload, then read the stored size back (a write's success is not proof)
  $S3 put-object --bucket "$BUCKET" --key "$1" --body "$2" >/dev/null
  REMOTE="$($S3 head-object --bucket "$BUCKET" --key "$1" --query ContentLength --output text)"
  [ "$REMOTE" = "$(stat -c%s "$2")" ] || { echo "[fail] $1: stored $REMOTE bytes of $(stat -c%s "$2")"; exit 1; }
}
dump_one() {
  NAME="$1"; HOST="$2"; export PGPASSWORD="$3"
  BASE="$PREFIX/$NAME/dumpall-$STAMP"
  fingerprint "$HOST" postgres > "/tmp/$NAME.fingerprint"
  pg_dumpall --clean --if-exists -h "$HOST" -U postgres | gzip -9 | age -r "$RECIPIENT" > "/tmp/$NAME.sql.gz.age"
  SIZE="$(stat -c%s "/tmp/$NAME.sql.gz.age")"
  # A pipe can quietly carry nothing: refuse a dump too small to hold a cluster.
  [ "$SIZE" -gt 1000 ] || { echo "[fail] $NAME: the dump is only $SIZE bytes"; exit 1; }
  put "$BASE.sql.gz.age" "/tmp/$NAME.sql.gz.age"
  put "$BASE.fingerprint" "/tmp/$NAME.fingerprint"
  rm -f "/tmp/$NAME.sql.gz.age" "/tmp/$NAME.fingerprint"
  UPLOADED=$((UPLOADED + 1))
  echo "[ok] $NAME -> $BASE.sql.gz.age ($SIZE bytes)"
}
${calls}
[ "$UPLOADED" -eq ${targets.length} ] || { echo "[fail] $UPLOADED of ${targets.length} dumps"; exit 1; }
# Prune by comparing timestamps in the shell: a JMESPath string comparison would silently match nothing.
CUT="$(date -u -d @"$(( $(date -u +%s) - RETENTION_HOURS * 3600 ))" +%Y%m%d%H%M%S)"
$S3 list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/" --query 'Contents[].Key' --output text | tr '\t' '\n' |
while read -r K; do
  T="$(echo "$K" | grep -oE 'dumpall-[0-9]{8}-[0-9]{6}\.(sql\.gz\.age|fingerprint)$' | tr -dc 0-9 || true)"
  if [ -n "$T" ] && [ "$T" -lt "$CUT" ]; then $S3 delete-object --bucket "$BUCKET" --key "$K" >/dev/null; echo "[pruned] $K"; fi
done
echo "[done] $UPLOADED dumps"`;
}

/**
 * Restores the newest dump of SOURCE into a throwaway server inside this pod
 * and compares fingerprints; exits 0 only when they match. Env: ENDPOINT
 * BUCKET PREFIX SOURCE; the age identity at /identity/key. Downloads and
 * decrypts as root (the identity is readable by root only), then runs the
 * server as postgres, which initdb requires.
 */
export function restoreCheckScript(): string {
  return String.raw`set -eu
set -o pipefail
apk add --no-cache aws-cli age su-exec >/dev/null
S3="aws --endpoint-url $ENDPOINT s3api"
fail() { echo "[fail] $SOURCE: $1"; exit 1; }
LATEST="$($S3 list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/$SOURCE/" --query 'Contents[].Key' --output text | tr '\t' '\n' |
  grep -E '/dumpall-[0-9]{8}-[0-9]{6}\.sql\.gz\.age$' | sort | tail -1 || true)"
[ -n "$LATEST" ] || fail "no dump under $PREFIX/$SOURCE/"
$S3 get-object --bucket "$BUCKET" --key "$LATEST" /work/dump.age >/dev/null
$S3 get-object --bucket "$BUCKET" --key "${"$"}{LATEST%.sql.gz.age}.fingerprint" /work/expected >/dev/null || fail "no fingerprint beside $LATEST"
age -d -i /identity/key /work/dump.age | gunzip > /work/dump.sql
chown -R postgres:postgres /work
export SOURCE LATEST
su-exec postgres sh -c "$(cat <<'AS_POSTGRES'
set -eu
set -o pipefail
${FINGERPRINT_FUNCTION}
initdb -D /work/pg -U restoreadmin --auth=trust >/dev/null
pg_ctl -D /work/pg -o "-c listen_addresses='' -k /work" -w start >/dev/null
trap 'pg_ctl -D /work/pg -m fast stop >/dev/null 2>&1 || true' EXIT
psql -v ON_ERROR_STOP=1 -q -h /work -U restoreadmin -d postgres -f /work/dump.sql >/dev/null
GOT="$(PGPASSWORD= fingerprint /work restoreadmin)"
WANT="$(cat /work/expected)"
if [ "$GOT" = "$WANT" ]; then echo "[ok] $SOURCE: $LATEST restores, fingerprint $GOT"; else echo "[fail] $SOURCE: $LATEST restores to $GOT, expected $WANT"; exit 1; fi
AS_POSTGRES
)"`;
}
