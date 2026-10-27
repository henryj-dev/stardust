#!/usr/bin/env bash
# Local quickstart: a kind cluster running stardust built from this checkout.
#
#   examples/kind/up.sh        # create (or reuse) the cluster and install
#   examples/kind/down.sh      # delete the cluster
#
# Requires docker, kind, kubectl and helm. The PostgreSQL here is a throwaway
# for local use only: its password is in this file and its data is not kept.
set -euo pipefail

CLUSTER="${CLUSTER:-stardust}"
NS=stardust
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

step() { echo "==> $*"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  step "creating kind cluster $CLUSTER"
  kind create cluster --name "$CLUSTER" --wait 120s
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

for target in server worker web; do
  step "building stardust-$target"
  docker build --quiet --target "$target" --tag "stardust-$target:local" "$repo" >/dev/null
  kind load docker-image --name "$CLUSTER" "stardust-$target:local" >/dev/null
done

step "starting PostgreSQL"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NS" apply -f "$here/postgres.yaml" >/dev/null
kubectl -n "$NS" rollout status deploy/postgres --timeout=180s
kubectl -n "$NS" create secret generic stardust-db \
  --from-literal=url="postgres://stardust:stardust@postgres:5432/stardust" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

step "installing the chart"
helm upgrade --install stardust "$repo/charts/stardust" --namespace "$NS" \
  --values "$here/values.yaml" --wait --timeout 5m

step "checking the services"
check() { # <service> <port> <path> <expected text>
  local pf_log pid ok=""
  pf_log="$(mktemp)"
  kubectl -n "$NS" port-forward "svc/$1" "1$2:$2" >"$pf_log" 2>&1 &
  pid=$!
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:1$2$3" 2>/dev/null | grep -q "$4"; then ok=1; break; fi
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  rm -f "$pf_log"
  [ -n "$ok" ] || { echo "FAIL [$1] $3 did not return \"$4\"" >&2; exit 1; }
  echo "ok   [$1]"
}
check stardust-server 8080 /healthz '"status":"ok"'
check stardust-web 3000 / '<title>stardust</title>'

cat <<EOF

stardust is running in kind cluster "$CLUSTER", namespace "$NS".

  kubectl -n $NS port-forward svc/stardust-web 3000:3000      # dashboard
  kubectl -n $NS port-forward svc/stardust-server 8080:8080   # API
EOF
