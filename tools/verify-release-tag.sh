#!/usr/bin/env bash
# Decides whether a tag may be released. Used by the release workflow before
# anything is built.
#
#   RELEASE_SIGNER_PUBKEY="ssh-ed25519 AAAA..." tools/verify-release-tag.sh <tag> [<main-ref>]
#
# The allowed signer comes from the environment (a repository variable in CI),
# never from a file in the repository, so a pull request cannot change it.
# Every check names its layer; the first failing layer stops the release.
set -euo pipefail

tag="${1:?usage: verify-release-tag.sh <tag> [<main-ref>]}"
main_ref="${2:-origin/main}"

stop() {
  echo "STOP [$1] $2" >&2
  exit 1
}

# Layer 1: only vMAJOR.MINOR.PATCH, optionally with a pre-release suffix.
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
  stop tag-format "\"$tag\" is not vMAJOR.MINOR.PATCH[-PRERELEASE]"
echo "ok   [tag-format]"

# Layer 2: a signer must be configured.
pubkey="${RELEASE_SIGNER_PUBKEY:-}"
[[ "$pubkey" =~ ^(ssh-ed25519|sk-ssh-ed25519@openssh.com|ecdsa-sha2-nistp256|sk-ecdsa-sha2-nistp256@openssh.com)\ [A-Za-z0-9+/=]+ ]] ||
  stop signer-configured "RELEASE_SIGNER_PUBKEY is not set to an SSH public key"
echo "ok   [signer-configured]"

# Layer 3: lightweight tags carry no signature.
[ "$(git cat-file -t "refs/tags/$tag" 2>/dev/null || true)" = "tag" ] ||
  stop tag-annotated "\"$tag\" is not an annotated tag"
echo "ok   [tag-annotated]"

# Layer 4: the tag is signed by the allowed signer.
signers="$(mktemp)"
trap 'rm -f "$signers"' EXIT
printf 'release namespaces="git" %s\n' "$pubkey" >"$signers"
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$signers" verify-tag "$tag" >/dev/null 2>&1 ||
  stop tag-signature "\"$tag\" is not signed by the allowed release signer"
echo "ok   [tag-signature]"

# Layer 5: the tagged commit has been merged to main.
git merge-base --is-ancestor "refs/tags/$tag^{commit}" "$main_ref" ||
  stop tag-on-main "\"$tag\" points at a commit that is not on $main_ref"
echo "ok   [tag-on-main]"
