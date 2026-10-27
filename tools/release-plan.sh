#!/usr/bin/env bash
# Decides whether the current main commit should be released.
#
#   tools/release-plan.sh [<remote>]
#
# Runs after the changesets step has found no pending changesets, i.e. right
# after a "Version Packages" pull request was merged — or on any later push.
# It releases the version in charts/stardust/package.json once: when a tag
# v<version> already exists, there is nothing to do. Writes `release` and
# `version` to $GITHUB_OUTPUT when set, and always to stdout.
set -euo pipefail

remote="${1:-origin}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p 'require(process.argv[1]).version' "$repo/charts/stardust/package.json")"

emit() {
  echo "release=$1"
  echo "version=$version"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'release=%s\nversion=%s\n' "$1" "$version" >>"$GITHUB_OUTPUT"
  fi
  echo "$2" >&2
}

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "STOP [version] \"$version\" is not semver" >&2
  exit 1
}

if [ "$version" = "0.0.0" ]; then
  emit false "skip [unversioned] nothing has been versioned yet"
elif git -C "$repo" ls-remote --exit-code --tags "$remote" "refs/tags/v$version" >/dev/null 2>&1; then
  emit false "skip [released] v$version already exists"
else
  emit true "go   [new-version] v$version has not been released"
fi
