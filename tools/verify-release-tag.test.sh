#!/usr/bin/env bash
# Exercises every layer of tools/verify-release-tag.sh in a throwaway
# repository with throwaway SSH keys generated for this run only.
#
# Each refused case must stop at its own layer, and the accepted case must
# pass every layer — a case that stops at the wrong layer is a failure.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/verify-release-tag.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

ssh-keygen -q -t ed25519 -N "" -C release -f "$work/release"
ssh-keygen -q -t ed25519 -N "" -C other -f "$work/other"
RELEASE_KEY="$(cat "$work/release.pub")"

repo="$work/repo"
git init -q -b main "$repo"
g() { git -C "$repo" -c user.name=test -c user.email=test@example.com -c gpg.format=ssh "$@"; }
g commit -q --allow-empty -m one
g update-ref refs/remotes/origin/main HEAD
g checkout -q -b side
g commit -q --allow-empty -m side-only
g checkout -q main

g -c user.signingkey="$work/release" tag -s v1.0.0 -m good main
g -c user.signingkey="$work/other" tag -s v1.0.1 -m wrong-key main
g tag -a v1.0.2 -m unsigned main
g tag v1.0.3 main
g -c user.signingkey="$work/release" tag -s v1.0.4 -m off-main side

expect() { # <name> <expected layer | pass> <pubkey> <tag>
  local name="$1" want="$2" key="$3" tag="$4" out got
  if out="$(cd "$repo" && RELEASE_SIGNER_PUBKEY="$key" bash "$script" "$tag" origin/main 2>&1)"; then
    got=pass
  else
    got="$(sed -n 's/^STOP \[\([a-z-]*\)\].*/\1/p' <<<"$out" | head -1)"
  fi
  if [ "$got" = "$want" ]; then
    echo "ok   [$name] -> $want"
  else
    echo "FAIL [$name] expected $want, got ${got:-nothing}: $out" >&2
    failures=$((failures + 1))
  fi
}

expect signed-on-main pass "$RELEASE_KEY" v1.0.0
expect bad-format tag-format "$RELEASE_KEY" release-1
expect no-signer signer-configured "" v1.0.0
expect lightweight tag-annotated "$RELEASE_KEY" v1.0.3
expect unsigned tag-signature "$RELEASE_KEY" v1.0.2
expect wrong-key tag-signature "$RELEASE_KEY" v1.0.1
expect off-main tag-on-main "$RELEASE_KEY" v1.0.4

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) failed" >&2
  exit 1
fi
