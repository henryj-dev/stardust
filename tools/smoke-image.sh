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
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$1$2" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# Stops the running container with SIGTERM and requires a clean exit well
# before docker's 10s kill. PID 1 ignores SIGTERM unless the process handles it.
stop_gracefully() { # <layer>
  docker stop --time 10 "$name" >/dev/null
  local code
  code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
  [ "$code" = "0" ] || fail "$1" "expected exit 0 after SIGTERM, got $code"
  docker logs "$name" 2>&1 | grep -q "stopping (SIGTERM)" || fail "$1" "no shutdown log line"
  echo "ok   [$1]"
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
    stop_gracefully server-sigterm
    ;;
  worker)
    docker run -d --name "$name" -e DATABASE_URL=postgres://smoke \
      -v "$config:/etc/stardust/stardust.yaml:ro" "$image" >/dev/null
    started=""
    for _ in $(seq 1 15); do
      if docker logs "$name" 2>&1 | grep -q "stardust worker started"; then started=1; break; fi
      sleep 1
    done
    [ -n "$started" ] || fail worker-start "no start-up log line"
    sleep 2
    [ "$(docker inspect --format '{{.State.Running}}' "$name")" = "true" ] || fail worker-start "worker exited on its own"
    echo "ok   [worker-start]"
    stop_gracefully worker-sigterm
    ;;
  web)
    docker run -d --name "$name" -p 127.0.0.1:13000:3000 "$image" >/dev/null
    wait_http 13000 / || fail web-root "GET / did not answer"
    curl -fsS http://127.0.0.1:13000/ | grep -q "<title>stardust</title>" || fail web-root "page has no title"
    echo "ok   [web-root]"
    docker stop --time 10 "$name" >/dev/null
    code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
    [ "$code" = "0" ] || fail web-sigterm "expected exit 0 after SIGTERM, got $code"
    echo "ok   [web-sigterm]"
    ;;
  *)
    echo "usage: $0 <server|worker|web> <image>" >&2
    exit 2
    ;;
esac
