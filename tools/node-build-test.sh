#!/usr/bin/env bash
# Builds the fixture apps with NODE_DOCKERFILE and the build arguments the
# builder passes, runs them, and checks what they serve:
#   - build/index.js is the entry, the port is the one given;
#   - the build environment arrived as plain values, a shell-looking one too,
#     and nothing in it was executed;
#   - install scripts did not run;
#   - server.js wins when present, and the module it imports was copied.
#
#   tools/node-build-test.sh        (needs docker and node)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fixtures="$here/tools/fixtures/node-app"
work="$(mktemp -d)"
ids=()
cleanup() {
  for id in ${ids[@]+"${ids[@]}"}; do docker rm -f "$id" >/dev/null 2>&1 || true; done
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
  id="$(docker run -d -p "127.0.0.1::$2" "$tag")"
  ids+=("$id")
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

body="$(serve custom-server 8124)"
expect server-js-preferred 'b.entry === "server.js" && b.note === "shutdown.js was copied"'
echo "ok   [node-build] the generated Dockerfile builds and runs Node apps"
