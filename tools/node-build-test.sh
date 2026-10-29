#!/usr/bin/env bash
# Builds the fixture apps with NODE_DOCKERFILE and the build arguments the
# builder passes, runs them, and checks what they serve:
#   - build/index.js is the entry, the port is the one given;
#   - the build environment arrived as plain values, a shell-looking one too,
#     and nothing in it was executed;
#   - install scripts did not run;
#   - server.js wins when present, and the module it imports was copied;
#   - every lockfile installs with pnpm, each by the way meant for it (the build
#     log names it): pnpm's frozen, npm's and yarn's imported with their pinned
#     versions kept, bun's or none resolved fresh, two package managers' refused.
#
#   tools/node-build-test.sh        (needs docker and node)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fixtures="$here/tools/fixtures/node-app"
work="$(mktemp -d)"
# Containers are found by a label for this run: serve() runs in a command
# substitution, a subshell, so a list it appended to would never reach here.
run_label="stardust-node-build-test=$$-$(basename "$work")"
cleanup() {
  docker ps -aq --filter "label=$run_label" | while read -r id; do docker rm -f "$id" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FAIL [$1] $2" >&2; exit 1; }
ok() { echo "ok   [$1]"; }

node --input-type=module -e "
import { NODE_DOCKERFILE, DEFAULT_IMAGES } from '$here/plugins/builder-buildkit/src/job.ts';
import { writeFileSync } from 'node:fs';
writeFileSync('$work/Dockerfile', NODE_DOCKERFILE);
writeFileSync('$work/node-image', DEFAULT_IMAGES.node);"
# Looks like shell on purpose: it must arrive as this exact text, unexpanded.
# shellcheck disable=SC2016
TRICKY='$(touch /tmp/pwned); `id`'
build_env="$(printf 'MARK=from-build-env\nTRICKY=%s\n' "$TRICKY" | base64 | tr -d '\n')"

serve() { # <fixture> <port> -> response body
  local tag="stardust-node-fixture-$1"
  docker build -q -f "$work/Dockerfile" \
    --build-arg "NODE_IMAGE=$(cat "$work/node-image")" --build-arg "PORT=$2" --build-arg "BUILD_ENV=$build_env" \
    -t "$tag" "$fixtures/$1" >/dev/null || fail "$1" "the build failed"
  local id
  id="$(docker run -d --label "$run_label" -p "127.0.0.1::$2" "$tag")"
  local hostport
  hostport="$(docker port "$id" "$2/tcp" | head -1)"
  for _ in $(seq 1 30); do
    if body="$(curl -fsS "http://$hostport/" 2>/dev/null)"; then printf '%s' "$body"; return 0; fi
    sleep 1
  done
  docker logs "$id" >&2 || true
  fail "$1" "no answer on port $2"
}

# expect <name> <JavaScript condition on the response body b>
expect() {
  if node -e "const b=JSON.parse(process.argv[1]); process.exit(($2) ? 0 : 1)" "$body"; then ok "$1"; else fail "$1" "$body"; fi
}

body="$(serve default 8123)"
expect entry-and-port 'b.entry === "build/index.js"'
expect build-env-arrives 'b.seen.MARK === "from-build-env"'
expect build-env-not-evaluated "b.seen.TRICKY === $(node -e 'console.log(JSON.stringify(process.argv[1]))' "$TRICKY")"
expect install-scripts-do-not-run 'b.seen.postinstallRan === false'
user="$(docker run --rm --entrypoint id stardust-node-fixture-default -u)"
if [ "$user" != 0 ]; then ok runs-as-non-root; else fail runs-as-non-root "uid $user"; fi
# Kubernetes with runAsNonRoot checks the image's configured user, and only a number passes.
configured="$(docker image inspect stardust-node-fixture-default --format '{{.Config.User}}')"
if [[ "$configured" =~ ^[1-9][0-9]*(:[0-9]+)?$ ]]; then ok user-is-numeric; else fail user-is-numeric "image user is '$configured'"; fi

body="$(serve custom-server 8124)"
expect server-js-preferred 'b.entry === "server.js" && b.note === "shutdown.js was copied"'

# The default fixture with its lockfile replaced by the parts named (tools/fixtures/node-app/lockfiles).
parts="$here/tools/fixtures/node-app/lockfiles"
variant() { # <name> <part:target>... -> directory
  local dir="$work/variant-$1"
  shift
  cp -R "$fixtures/default" "$dir"
  rm -f "$dir/package-lock.json"
  local p
  for p in "$@"; do cp "$parts/${p%%:*}" "$dir/${p#*:}"; done
  printf '%s' "$dir"
}
# lane <name> <expected install line> <variant dir> -> builds; fails unless the log names the way taken
# --no-cache: a cached install step prints nothing, and the log would not say which way it took.
lane() {
  local tag="stardust-node-fixture-$1" log="$work/build-$1.log"
  docker build --no-cache --progress=plain -f "$work/Dockerfile" \
    --build-arg "NODE_IMAGE=$(cat "$work/node-image")" --build-arg "PORT=8125" --build-arg "BUILD_ENV=$build_env" \
    -t "$tag" "$3" >"$log" 2>&1 || { tail -20 "$log" >&2; fail "$1" "the build failed"; }
  grep -qF "[node-build] install: $2" "$log" || { grep -F "[node-build]" "$log" >&2; fail "$1" "the log does not say: $2"; }
  ok "$1"
}
dep_version() { docker run --rm --entrypoint node "stardust-node-fixture-$1" -p 'require("/app/node_modules/ms/package.json").version'; }

lane install-pnpm-frozen "pnpm-lock.yaml, frozen" "$(variant pnpm empty.pnpm-lock.yaml:pnpm-lock.yaml)"
lane install-npm-imported "imported package-lock.json into pnpm-lock.yaml" \
  "$(variant npm pinned.package.json:package.json pinned.package-lock.json:package-lock.json)"
[ "$(dep_version install-npm-imported)" = 2.1.2 ] && ok npm-pins-kept || fail npm-pins-kept "ms $(dep_version install-npm-imported), the lockfile pins 2.1.2"
lane install-yarn-imported "imported yarn.lock into pnpm-lock.yaml" \
  "$(variant yarn pinned.package.json:package.json pinned.yarn.lock:yarn.lock)"
[ "$(dep_version install-yarn-imported)" = 2.1.2 ] && ok yarn-pins-kept || fail yarn-pins-kept "ms $(dep_version install-yarn-imported), the lockfile pins 2.1.2"
lane install-bun-fresh "bun.lock is not a lockfile pnpm reads, resolving fresh" \
  "$(variant bun pinned.package.json:package.json empty.bun.lock:bun.lock)"
# Fresh means from package.json: ^2.1.2 resolves past the 2.1.2 the other lockfiles pin.
[ "$(dep_version install-bun-fresh)" != 2.1.2 ] && ok bun-resolved-fresh || fail bun-resolved-fresh "ms 2.1.2 came from nowhere"
lane install-none-fresh "no lockfile, resolving fresh" "$(variant none)"
# An app that names another package manager still installs with pnpm (corepack and pnpm would both refuse).
yarn_named="$(variant yarn-named pinned.package.json:package.json pinned.yarn.lock:yarn.lock)"
node -e 'const f=process.argv[1], p=JSON.parse(require("fs").readFileSync(f)); p.packageManager="yarn@1.22.22"; require("fs").writeFileSync(f, JSON.stringify(p))' "$yarn_named/package.json"
lane install-other-pm-named "imported yarn.lock into pnpm-lock.yaml" "$yarn_named"

two="$(variant two pinned.package.json:package.json pinned.package-lock.json:package-lock.json pinned.yarn.lock:yarn.lock)"
if docker build --progress=plain -f "$work/Dockerfile" --build-arg "NODE_IMAGE=$(cat "$work/node-image")" \
  -t stardust-node-fixture-two "$two" >"$work/build-two.log" 2>&1; then
  fail two-package-managers-refused "the build went ahead with both package-lock.json and yarn.lock"
fi
grep -qF "lockfiles of more than one package manager: package-lock.json yarn.lock" "$work/build-two.log" &&
  ok two-package-managers-refused || fail two-package-managers-refused "it failed for another reason"
echo "ok   [node-build] the generated Dockerfile builds and runs Node apps"
