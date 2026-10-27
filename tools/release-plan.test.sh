#!/usr/bin/env bash
# Drives tools/release-plan.sh against a scratch repository and remote.
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

git init -q --bare "$work/remote.git"
mkdir -p "$work/repo/tools" "$work/repo/charts/stardust"
cp "$src/tools/release-plan.sh" "$work/repo/tools/"
git -C "$work/repo" init -q -b main
git -C "$work/repo" remote add origin "$work/remote.git"
g() { git -C "$work/repo" -c user.name=t -c user.email=t@example.com "$@"; }

set_version() {
  printf '{ "name": "stardust", "version": "%s", "private": true }\n' "$1" >"$work/repo/charts/stardust/package.json"
  g add -A && g commit -q -m "v$1" && g push -q origin main
}

expect() { # <name> <release true|false|stop>
  local out got
  if out="$(bash "$work/repo/tools/release-plan.sh" origin 2>/dev/null)"; then
    got="$(sed -n 's/^release=//p' <<<"$out")"
  else
    got=stop
  fi
  if [ "$got" = "$2" ]; then
    echo "ok   [$1] -> $2"
  else
    echo "FAIL [$1] expected $2, got $got" >&2
    failures=$((failures + 1))
  fi
}

set_version 0.0.0
expect unversioned false
set_version 0.1.0
expect new-version true
g tag v0.1.0 && g push -q origin v0.1.0
expect already-released false
set_version 0.1.1-rc.1
expect prerelease true
set_version not-a-version
expect bad-version stop

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) failed" >&2
  exit 1
fi
