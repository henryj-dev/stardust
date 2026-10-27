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
ssh-keygen -q -t ed25519 -N "" -C backup -f "$work/backup"
ssh-keygen -q -t ed25519 -N "" -C other -f "$work/other"
# Two allowed signers, with the blank lines and comments a real variable has.
SIGNERS="$(printf '# primary\n%s\n\n# backup\n%s\n' "$(cat "$work/release.pub")" "$(cat "$work/backup.pub")")"
BACKUP_FP="$(ssh-keygen -lf "$work/backup.pub" | awk '{print $2}')"

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
g -c user.signingkey="$work/backup" tag -s v1.0.5 -m backup-key main

expect() { # <name> <expected layer | pass> <pubkey> <tag>
  local name="$1" want="$2" key="$3" tag="$4" out got
  if out="$(cd "$repo" && RELEASE_SIGNERS="$key" bash "$script" "$tag" origin/main 2>&1)"; then
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

expect signed-on-main pass "$SIGNERS" v1.0.0
expect second-signer pass "$SIGNERS" v1.0.5
expect bad-format tag-format "$SIGNERS" release-1
expect no-signer signer-configured "" v1.0.0
expect only-comments signer-configured "# nobody" v1.0.0
expect malformed-line signer-configured "$(printf '%s\nnot-a-key\n' "$SIGNERS")" v1.0.0
expect lightweight tag-annotated "$SIGNERS" v1.0.3
expect unsigned tag-signature "$SIGNERS" v1.0.2
expect unlisted-key tag-signature "$SIGNERS" v1.0.1
expect off-main tag-on-main "$SIGNERS" v1.0.4

# The log must name the key that signed.
# Capture first: with pipefail, `... | grep -q` fails when grep exits early.
log="$(cd "$repo" && RELEASE_SIGNERS="$SIGNERS" bash "$script" v1.0.5 origin/main 2>&1)"
if grep -qF "signed with $BACKUP_FP" <<<"$log"; then
  echo "ok   [records-fingerprint]"
else
  echo "FAIL [records-fingerprint] the backup key's fingerprint is not in the log" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) failed" >&2
  exit 1
fi
