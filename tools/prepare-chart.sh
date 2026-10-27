#!/usr/bin/env bash
# Stamps a release into the chart: version, appVersion and the image digests.
#
#   tools/prepare-chart.sh <version> <digest-dir>
#
# <digest-dir> holds one file per component (server, worker, web) containing
# that image's sha256 digest. Requires yq v4 (preinstalled on GitHub runners).
set -euo pipefail

version="${1:?usage: prepare-chart.sh <version> <digest-dir>}"
dir="${2:?usage: prepare-chart.sh <version> <digest-dir>}"
chart="$(cd "$(dirname "$0")/.." && pwd)/charts/stardust"

stop() {
  echo "STOP [$1] $2" >&2
  exit 1
}

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || stop version "\"$version\" is not semver"

for component in server worker web; do
  [ -f "$dir/$component" ] || stop digest "missing digest for $component"
  digest="$(tr -d '[:space:]' <"$dir/$component")"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || stop digest "$component digest \"$digest\" is malformed"
  DIGEST="$digest" yq -i ".image.${component}.digest = strenv(DIGEST)" "$chart/values.yaml"
done

VERSION="$version" yq -i '.version = strenv(VERSION) | .appVersion = strenv(VERSION)' "$chart/Chart.yaml"
echo "chart stamped with $version"
