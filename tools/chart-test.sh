#!/usr/bin/env bash
# Chart tests: lint, schema validation of the rendered manifests, and cases
# that must be rejected — each with the message that proves *why* it failed.
#
#   tools/chart-test.sh
set -euo pipefail

HELM="alpine/helm:4.3.1@sha256:e3f8d5c462d75470fbb1fce79ad5c20063657096d1f98c0fcea869e2600e2e5e"
KUBECONFORM="ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e"
repo="$(cd "$(dirname "$0")/.." && pwd)"
DIGEST="sha256:$(printf 'a%.0s' $(seq 1 64))"
failures=0

helm() { docker run --rm -v "$repo/charts:/charts:ro" "$HELM" "$@"; }
pass() { echo "ok   [$1]"; }
bad() { echo "FAIL [$1] $2" >&2; failures=$((failures + 1)); }

render() { helm template t /charts/stardust --set database.existingSecret=db "$@" 2>&1; }

# Must succeed.
if out="$(helm lint /charts/stardust --strict --set database.existingSecret=db 2>&1)"; then
  pass lint
else
  bad lint "$out"
fi

if out="$(render | docker run --rm -i "$KUBECONFORM" -strict -summary -kubernetes-version 1.30.0 - 2>&1)"; then
  pass kubeconform
else
  bad kubeconform "$out"
fi

out="$(render --set "image.server.digest=$DIGEST")"
if grep -q "image: ghcr.io/henryj-dev/stardust-server@$DIGEST" <<<"$out" \
  && ! grep -q "image: ghcr.io/henryj-dev/stardust-server:" <<<"$out"; then
  pass digest-pins-image
else
  bad digest-pins-image "server image is not pinned to the digest"
fi

out="$(render)"
if grep -q "image: ghcr.io/henryj-dev/stardust-server:0.0.0" <<<"$out"; then
  pass tag-defaults-to-app-version
else
  bad tag-defaults-to-app-version "expected the appVersion tag"
fi

pods="$(grep -c '^      automountServiceAccountToken: false' <<<"$out" || true)"
if [ "$pods" = "3" ]; then
  pass no-service-account-token
else
  bad no-service-account-token "expected 3 pod specs without a token, found $pods"
fi

# Builds: the worker alone gets a token, and the Role stays within its namespace.
out="$(render --set builds.enabled=true --set builds.namespace=ci-builds)"
worker="$(awk '/^# Source: stardust\/templates\/worker.yaml/{w=1} /^---/{w=0} w' <<<"$out")"
if grep -q "automountServiceAccountToken: true" <<<"$worker" && grep -q "serviceAccountName: t-stardust-worker" <<<"$worker"; then
  pass builds-worker-token
else
  bad builds-worker-token "the worker does not run with its own token"
fi
if [ "$(grep -c '^      automountServiceAccountToken: false' <<<"$out")" = "2" ]; then
  pass builds-others-no-token
else
  bad builds-others-no-token "server and web must stay without a token"
fi
role="$(awk '/^kind: Role$/{r=1} /^---/{r=0} r' <<<"$out")"
if grep -q "namespace: ci-builds" <<<"$role" && ! grep -qE 'secrets|"\*"|\*' <<<"$role" \
  && [ "$(grep -c 'resources:' <<<"$role")" = "3" ]; then
  pass builds-role-scoped
else
  bad builds-role-scoped "the Role is not limited to jobs, pods and pods/log in the builds namespace"
fi
if render --set builds.enabled=true | docker run --rm -i "$KUBECONFORM" -strict -summary -kubernetes-version 1.30.0 - >/dev/null 2>&1; then
  pass builds-kubeconform
else
  bad builds-kubeconform "manifests with builds enabled do not validate"
fi
if ! grep -q "kind: Role" <<<"$(render)"; then pass builds-off-no-role; else bad builds-off-no-role "a Role exists with builds disabled"; fi

# Flux appends the OCI digest to the chart version as build metadata
# ("0.1.0+e6f18c5ec407"). Every label value must still be a valid label: the
# API server refuses the whole install otherwise (found installing v0.1.0 with
# Flux). kubeconform's schemas do not check label syntax, so this does.
plus="$(mktemp -d)"
cp -R "$repo/charts/stardust" "$plus/stardust"
sed -i.bak -E 's/^version: .*/version: 0.1.0+e6f18c5ec407/' "$plus/stardust/Chart.yaml"
out="$(docker run --rm -v "$plus:/charts:ro" "$HELM" template t /charts/stardust --set database.existingSecret=db --set builds.enabled=true 2>&1)"
rm -rf "$plus"
invalid="$(awk '/^  labels:/{l=1;next} l && /^    [^ ]/{print; next} {l=0}' <<<"$out" \
  | sed -E 's/^ +[^:]+: *"?([^"]*)"?$/\1/' | grep -vE '^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$' | sort -u || true)"
if grep -q 'helm.sh/chart: stardust-0.1.0_e6f18c5ec407' <<<"$out" && [ -z "$invalid" ]; then
  pass labels-valid-with-build-metadata
else
  bad labels-valid-with-build-metadata "invalid label values: ${invalid:-none, but the chart label was not rewritten}"
fi

# Must be rejected, for the stated reason.
reject() { # <name> <expected message> <helm args...>
  local name="$1" expected="$2"
  shift 2
  local out
  if out="$(helm template t /charts/stardust "$@" 2>&1)"; then
    bad "$name" "was accepted"
  elif grep -q -- "$expected" <<<"$out"; then
    pass "$name"
  else
    bad "$name" "rejected for another reason: $out"
  fi
}

reject missing-database-secret "database.existingSecret is required"
reject plaintext-database-url "config.database.url" \
  --set database.existingSecret=db --set config.database.url=postgres://user:pass@db/x
reject unknown-value "additional properties 'nope' not allowed" \
  --set database.existingSecret=db --set nope=1
reject malformed-digest "image.server.digest" \
  --set database.existingSecret=db --set image.server.digest=latest

if [ "$failures" -ne 0 ]; then
  echo "$failures chart test(s) failed" >&2
  exit 1
fi
