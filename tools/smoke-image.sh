#!/usr/bin/env bash
# Start-up smoke test for a built image.
#
#   tools/smoke-image.sh <server|worker|web> <image>
#
# Each check prints the layer it belongs to, so a failure says which one stopped.
set -euo pipefail

target="$1"
image="$2"
here="$(cd "$(dirname "$0")/.." && pwd)"
config="$here/examples/stardust.yaml"
name="stardust-smoke-$target-$$"

fail() {
  echo "FAIL [$1] $2" >&2
  docker logs "$name" 2>&1 | tail -20 >&2 || true
  exit 1
}
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_http() { # <port> <path>
  local i
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$1$2" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

case "$target" in
  server)
    # Layer 1: invalid configuration is refused inside the image.
    out="$(docker run --rm -v "$config:/etc/stardust/stardust.yaml:ro" "$image" 2>&1 || true)"
    if ! grep -q "database.url: environment variable DATABASE_URL is not set" <<<"$out"; then
      fail config-refused "expected the missing DATABASE_URL to be reported, got: $out"
    fi
    echo "ok   [config-refused]"
    # Layer 2: valid configuration starts and serves /healthz.
    docker run -d --name "$name" -p 127.0.0.1:18080:8080 -e DATABASE_URL=postgres://smoke \
      -v "$config:/etc/stardust/stardust.yaml:ro" "$image" >/dev/null
    wait_http 18080 /healthz || fail healthz "GET /healthz did not answer"
    curl -fsS http://127.0.0.1:18080/healthz | grep -q '"status":"ok"' || fail healthz "unexpected /healthz body"
    echo "ok   [healthz]"
    ;;
  worker)
    if ! out="$(docker run --rm -e DATABASE_URL=postgres://smoke \
      -v "$config:/etc/stardust/stardust.yaml:ro" "$image" 2>&1)"; then
      fail worker-start "exited non-zero: $out"
    fi
    grep -q "stardust worker started" <<<"$out" || fail worker-start "unexpected output: $out"
    echo "ok   [worker-start]"
    ;;
  web)
    docker run -d --name "$name" -p 127.0.0.1:13000:3000 "$image" >/dev/null
    wait_http 13000 / || fail web-root "GET / did not answer"
    curl -fsS http://127.0.0.1:13000/ | grep -q "<title>stardust</title>" || fail web-root "page has no title"
    echo "ok   [web-root]"
    ;;
  *)
    echo "usage: $0 <server|worker|web> <image>" >&2
    exit 2
    ;;
esac
