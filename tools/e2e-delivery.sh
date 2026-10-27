#!/usr/bin/env bash
# Push-to-deploy end to end in a kind cluster:
#
#   a commit pushed to Gitea → Gitea's GitHub-compatible webhook → stardust
#   starts a run → the worker builds the image in a Job and pushes it to a
#   local registry → the deploy repository is bumped to the digest → Flux
#   applies it → a pod runs the image that was just built.
#
# Expects a kind cluster created with examples/kind/delivery/kind-config.yaml
# (CI's e2e-delivery job does that) and docker, kind, kubectl, helm, curl, jq.
# Each step prints its name; a failure says which step stopped.
set -euo pipefail

CLUSTER="${CLUSTER:-stardust}"
here="$(cd "$(dirname "$0")/.." && pwd)"
fixtures="$here/examples/kind/delivery"
work="$(mktemp -d)"
REGISTRY_IMAGE="registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e"
FLUX_INSTALL="https://github.com/fluxcd/flux2/releases/download/v2.8.6/install.yaml"
FLUX_SHA256="cb6dadb9f2525dd6665c1cd3f206ef0078e912499e923278844cc8a47906e93c"
GITEA="http://gitea.git.svc.cluster.local:3000"
pids=()

cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

step() { echo "==> [$1] ${*:2}"; }
fail() {
  echo "FAIL [$1] $2" >&2
  exit 1
}
# wait_for <step> <seconds> <command...>
wait_for() {
  local name="$1" seconds="$2"
  shift 2
  for _ in $(seq 1 "$seconds"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "$name" "timed out after ${seconds}s waiting for: $*"
}
port_forward() { # <namespace> <service> <local> <remote>
  kubectl -n "$1" port-forward "svc/$2" "$3:$4" >"$work/pf-$2.log" 2>&1 &
  pids+=("$!")
  wait_for "port-forward-$2" 30 curl -s -o /dev/null "http://127.0.0.1:$3/"
}

# ---------------------------------------------------------------- registry
step registry "local registry on the kind network, reachable by IP"
docker rm -f kind-registry >/dev/null 2>&1 || true
docker run -d --name kind-registry --network kind "$REGISTRY_IMAGE" >/dev/null
REG_IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' kind-registry)"
REG="$REG_IP:5000"
for node in $(kind get nodes --name "$CLUSTER"); do
  docker exec "$node" mkdir -p "/etc/containerd/certs.d/$REG"
  printf 'server = "http://%s"\n\n[host."http://%s"]\n  capabilities = ["pull", "resolve"]\n' "$REG" "$REG" |
    docker exec -i "$node" tee "/etc/containerd/certs.d/$REG/hosts.toml" >/dev/null
done
echo "     registry $REG"

# ---------------------------------------------------------------- stardust base
step base "stardust, PostgreSQL and images from this checkout"
CLUSTER="$CLUSTER" "$here/examples/kind/up.sh"

# ---------------------------------------------------------------- gitea
step gitea "Gitea with an admin token"
SERVER_IP="$(kubectl -n stardust get svc stardust-server -o jsonpath='{.spec.clusterIP}')"
[ -n "$SERVER_IP" ] || fail gitea "stardust-server has no cluster IP"
sed "s/STARDUST_SERVER_IP/$SERVER_IP/" "$fixtures/gitea.yaml" | kubectl apply -f - >/dev/null
kubectl -n git rollout status deploy/gitea --timeout=300s
kubectl -n git exec deploy/gitea -- gitea admin user create --admin --username e2e \
  --password "e2e-$(openssl rand -hex 8)" --email e2e@example.com --must-change-password=false >/dev/null
TOKEN="$(kubectl -n git exec deploy/gitea -- gitea admin user generate-access-token \
  --username e2e --token-name e2e --scopes all --raw | tail -1 | tr -d '\r')"
[ -n "$TOKEN" ] || fail gitea "no access token"
port_forward git gitea 13000 3000
api() { curl -fsS -H "Authorization: token $TOKEN" -H "content-type: application/json" "$@"; }
for repo in app deploy; do
  api -X POST "http://127.0.0.1:13000/api/v1/user/repos" -d "{\"name\":\"$repo\",\"default_branch\":\"main\"}" >/dev/null
done

# Pushes with the token in git's environment, not in a URL.
gitpush() { # <dir> <repo> <message>
  local basic
  basic="$(printf 'e2e:%s' "$TOKEN" | base64 | tr -d '\n')"
  git -C "$1" add -A
  git -C "$1" -c user.name=e2e -c user.email=e2e@example.com commit -q -m "$3"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $basic" \
    git -C "$1" push -q "http://127.0.0.1:13000/e2e/$2.git" HEAD:main
}

step seed "app and deploy repositories"
mkdir -p "$work/app" "$work/deploy"
cp -R "$fixtures/app/." "$work/app/"
mkdir -p "$work/deploy/deploy"
cp -R "$fixtures/deploy/." "$work/deploy/deploy/"
sed -i.bak "s#REGISTRY/demo/api#$REG/demo/api#" "$work/deploy/deploy/demo/api/deployment.yaml"
rm "$work/deploy/deploy/demo/api/deployment.yaml.bak"
for d in app deploy; do git -C "$work/$d" init -q -b main; done
gitpush "$work/app" app "initial"
gitpush "$work/deploy" deploy "initial"

# ---------------------------------------------------------------- flux
step flux "Flux v2.8.6 watching the deploy repository"
curl -fsSL "$FLUX_INSTALL" -o "$work/flux.yaml"
echo "$FLUX_SHA256  $work/flux.yaml" | sha256sum -c - >/dev/null || fail flux "install.yaml checksum mismatch"
kubectl apply -f "$work/flux.yaml" >/dev/null
kubectl -n flux-system rollout status deploy/source-controller --timeout=300s
kubectl -n flux-system rollout status deploy/kustomize-controller --timeout=300s
kubectl -n flux-system create secret generic gitea-auth --from-literal=username=e2e --from-literal=password="$TOKEN"
kubectl apply -f "$fixtures/flux.yaml" >/dev/null

# ---------------------------------------------------------------- stardust delivery config
step configure "stardust with the GitHub source, BuildKit builder and Git deploy repository"
WEBHOOK_SECRET="$(openssl rand -hex 16)"
ADMIN_PASSWORD="$(openssl rand -hex 16)"
kubectl create namespace stardust-builds
kubectl -n stardust-builds create secret generic git-clone --from-literal=token="$TOKEN"
kubectl -n stardust-builds create secret generic registry-push --from-literal=config.json='{"auths":{}}'
kubectl -n stardust create secret generic stardust-delivery \
  --from-literal=SOURCE_TOKEN="$TOKEN" --from-literal=DEPLOY_TOKEN="$TOKEN" \
  --from-literal=WEBHOOK_SECRET="$WEBHOOK_SECRET" --from-literal=ADMIN_PASSWORD="$ADMIN_PASSWORD"
cat >"$work/delivery-values.yaml" <<EOF
builds:
  enabled: true
  namespace: stardust-builds
extraEnvFrom:
  - secretRef:
      name: stardust-delivery
config:
  version: 1
  server:
    port: 8080
    publicUrl: http://localhost:8080
    bootstrapAdmin: { username: admin, password: { env: ADMIN_PASSWORD } }
  database:
    url: { env: DATABASE_URL }
  plugins:
    source-github:
      apiBaseUrl: $GITEA/api/v1
      token: { env: SOURCE_TOKEN }
      webhookSecret: { env: WEBHOOK_SECRET }
    builder-buildkit:
      namespace: stardust-builds
      registry: "$REG"
      cloneSecret: git-clone
      pushSecret: registry-push
      gitBaseUrl: $GITEA
      cloneUsername: e2e
      insecureRegistry: true
    gitops-git:
      url: $GITEA/e2e/deploy.git
      branch: main
      username: e2e
      token: { env: DEPLOY_TOKEN }
EOF
helm upgrade stardust "$here/charts/stardust" --namespace stardust --reuse-values \
  --values "$here/examples/kind/values.yaml" --values "$work/delivery-values.yaml" --wait --timeout 5m
port_forward stardust stardust-server 18080 8080
ADMIN_TOKEN="$(curl -fsS -H "content-type: application/json" http://127.0.0.1:18080/api/v1/auth/login \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r .token)"
[ -n "$ADMIN_TOKEN" ] && [ "$ADMIN_TOKEN" != null ] || fail "the bootstrap administrator could not sign in"
sapi() { curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" "$@"; }
sapi -X PUT http://127.0.0.1:18080/api/v1/projects/demo -d '{
  "name": "Demo",
  "githubRepo": "e2e/app",
  "pipelineDef": { "on": { "push": { "branches": ["main"] } }, "jobs": { "api": { "pipeline": "C", "component": "api" } } },
  "components": [{ "name": "api", "pipeline": "C", "deployDir": "deploy/demo/api" }]
}' >/dev/null
api -X POST "http://127.0.0.1:13000/api/v1/repos/e2e/app/hooks" -d "{
  \"type\": \"gitea\", \"active\": true, \"events\": [\"push\"], \"branch_filter\": \"*\",
  \"config\": { \"url\": \"http://stardust-server.stardust.svc.cluster.local:8080/webhooks/github/demo\",
                \"content_type\": \"json\", \"secret\": \"$WEBHOOK_SECRET\" }
}" >/dev/null

# ---------------------------------------------------------------- the push
MESSAGE="delivered-$(openssl rand -hex 6)"
step push "a commit that changes what the image prints: $MESSAGE"
echo "$MESSAGE" >"$work/app/message.txt"
gitpush "$work/app" app "feat: $MESSAGE"
SHA="$(git -C "$work/app" rev-parse HEAD)"

step run "the run for ${SHA:0:7} finishes"
run_status() { sapi http://127.0.0.1:18080/api/v1/projects/demo/runs | jq -r --arg sha "$SHA" '.runs[] | select(.sha == $sha) | .status'; }
for i in $(seq 1 180); do
  status="$(run_status || true)"
  case "$status" in success | failed | cancelled) break ;; esac
  # A run that has not started within three minutes never will.
  if [ -z "$status" ] && [ "$i" -ge 36 ]; then break; fi
  sleep 5
done
runs="$(sapi http://127.0.0.1:18080/api/v1/projects/demo/runs)"
[ "${status:-}" = "success" ] || {
  echo "$runs" | jq --arg sha "$SHA" '.runs[] | select(.sha == $sha)' >&2
  kubectl -n stardust logs deploy/stardust-server --tail=50 >&2 || true
  kubectl -n stardust logs deploy/stardust-worker --tail=50 >&2 || true
  fail run "the run ended as '${status:-never started}'"
}
DIGEST="$(echo "$runs" | jq -r --arg sha "$SHA" '.runs[] | select(.sha == $sha) | .jobs[0].detail.digest')"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail run "the job recorded no digest"
echo "     built $DIGEST"

step deploy-commit "the deploy repository was bumped by stardust"
subject="$(api "http://127.0.0.1:13000/api/v1/repos/e2e/deploy/commits?limit=1" | jq -r '.[0].commit.message' | head -1)"
[ "$subject" = "chore(demo/api): image -> ${SHA:0:7}" ] || fail deploy-commit "latest deploy commit is '$subject'"

step flux-applied "the Deployment runs the digest that was built"
image_is_pinned() {
  kubectl -n demo get deploy api -o jsonpath='{.spec.template.spec.containers[0].image}' | grep -qF "@$DIGEST"
}
wait_for flux-applied 300 image_is_pinned
kubectl -n demo rollout status deploy/api --timeout=300s

step running "the new pod prints this run's message"
logs_have_message() { kubectl -n demo logs deploy/api | grep -qx "$MESSAGE"; }
wait_for running 120 logs_have_message
echo "ok   [delivery] push -> build -> deploy commit -> Flux -> running pod"
