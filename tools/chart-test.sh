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
