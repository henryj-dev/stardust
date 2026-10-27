#!/usr/bin/env bash
# Verifies a published release the way a deployment would.
#
#   tools/verify-release.sh <version>
#
# Pulls the chart from GHCR, reads the image digests pinned in it, and checks
# with cosign that the chart and every pinned image were signed by the release
# workflow on main. As a control, it also requires verification against a
# wrong identity to FAIL — otherwise "verified" would not mean anything.
# Needs helm, cosign and a registry login that can read the packages.
set -euo pipefail

version="${1:?usage: verify-release.sh <version>}"
owner="${OWNER:-henryj-dev}"
repo_name="${REPO_NAME:-stardust}"
registry="ghcr.io/$owner"
issuer="https://token.actions.githubusercontent.com"
identity="https://github.com/$owner/$repo_name/.github/workflows/release.yml@refs/heads/main"
wrong_identity="https://github.com/$owner/$repo_name/.github/workflows/release.yml@refs/heads/not-main"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
ok() { echo "ok   [$1]"; }
bad() {
  echo "FAIL [$1] $2" >&2
  failures=$((failures + 1))
}

verify() { # <layer> <ref> <identity> -> exit status of cosign
  cosign verify "$2" --certificate-oidc-issuer "$issuer" --certificate-identity "$3" >/dev/null 2>"$work/$1.err"
}

# The chart, by digest.
helm pull "oci://$registry/charts/stardust" --version "$version" --destination "$work" >"$work/pull.log" 2>&1 ||
  { cat "$work/pull.log" >&2; bad chart-pull "cannot pull chart $version"; exit 1; }
chart_digest="$(sed -n 's/^Digest: \(sha256:[a-f0-9]*\)$/\1/p' "$work/pull.log" | head -1)"
[ -n "$chart_digest" ] || { bad chart-pull "helm pull printed no digest"; exit 1; }
ok "chart-pull $chart_digest"

if verify chart "$registry/charts/stardust@$chart_digest" "$identity"; then ok chart-signature; else bad chart-signature "$(tail -1 "$work/chart.err")"; fi

# Control: the same artifact must not verify against another identity.
if verify control "$registry/charts/stardust@$chart_digest" "$wrong_identity"; then
  bad control "the chart verified against a wrong identity; verification is not checking identity"
else
  ok control-wrong-identity-rejected
fi

# Every image pinned in the chart.
tar -xzf "$work/stardust-$version.tgz" -C "$work"
for component in server worker web; do
  digest="$(awk -v c="  $component:" '$0 == c {in_c=1; next} in_c && /^  [a-z]/ {in_c=0} in_c && /digest:/ {gsub(/[" ]/, "", $2); print $2; exit}' "$work/stardust/values.yaml")"
  if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    bad "$component-pinned" "values.yaml has no digest for $component"
    continue
  fi
  ok "$component-pinned $digest"
  if verify "$component" "$registry/stardust-$component@$digest" "$identity"; then
    ok "$component-signature"
  else
    bad "$component-signature" "$(tail -1 "$work/$component.err")"
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed for $version" >&2
  exit 1
fi
echo "release $version verified"
