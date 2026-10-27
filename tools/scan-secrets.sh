#!/usr/bin/env bash
# Secret scan with a built-in control.
#
#   tools/scan-secrets.sh
#
# Layer 1 (canary): a fake token generated at run time must be detected. If it
# is not, the scanner is not really running and a clean result would mean
# nothing. The token is never written into the repository.
# Layer 2 (history): the whole git history must be free of secrets.
set -euo pipefail

IMAGE="ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
repo="$(cd "$(dirname "$0")/.." && pwd)"
canary="$(mktemp -d)"
trap 'rm -rf "$canary"' EXIT

printf 'token = "ghp_%s"\n' "$(openssl rand -hex 18)" >"$canary/canary.txt"
# A distinct exit code tells "found a leak" apart from "docker or gitleaks broke".
set +e
docker run --rm -v "$canary:/scan:ro" "$IMAGE" dir /scan --no-banner --redact --exit-code 42 >/dev/null 2>&1
status=$?
set -e
if [ "$status" -ne 42 ]; then
  echo "FAIL [canary] expected gitleaks to report the generated token (exit 42), got exit $status" >&2
  exit 1
fi
echo "ok   [canary]"

if ! docker run --rm -v "$repo:/repo:ro" "$IMAGE" git /repo --no-banner --redact --verbose; then
  echo "FAIL [history] secrets found in git history" >&2
  exit 1
fi
echo "ok   [history]"
