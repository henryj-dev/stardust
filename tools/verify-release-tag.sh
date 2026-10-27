#!/usr/bin/env bash
# Decides whether a tag may be released. Used by the release workflow before
# anything is built.
#
#   RELEASE_SIGNERS="<one SSH public key per line>" tools/verify-release-tag.sh <tag> [<main-ref>]
#
# The allowed signers come from the environment (a repository variable in CI),
# never from a file in the repository, so a pull request cannot change them.
# Any one of them may sign a release; blank lines and # comments are ignored.
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

# Layer 2: at least one signer is configured, and every listed line is a key.
signers="$(mktemp)"
trap 'rm -f "$signers"' EXIT
count=0
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] || [ "${line:0:1}" = "#" ] && continue
  [[ "$line" =~ ^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp256|sk-ecdsa-sha2-nistp256@openssh\.com)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] ||
    stop signer-configured "RELEASE_SIGNERS line $lineno is not an SSH public key"
  printf 'release namespaces="git" %s\n' "$line" >>"$signers"
  count=$((count + 1))
done <<<"${RELEASE_SIGNERS:-}"
[ "$count" -gt 0 ] || stop signer-configured "RELEASE_SIGNERS has no SSH public key"
echo "ok   [signer-configured] $count allowed signer(s)"

# Layer 3: lightweight tags carry no signature.
[ "$(git cat-file -t "refs/tags/$tag" 2>/dev/null || true)" = "tag" ] ||
  stop tag-annotated "\"$tag\" is not an annotated tag"
echo "ok   [tag-annotated]"

# Layer 4: the tag is signed by one of the allowed signers. The key's
# fingerprint goes into the log so every release records which key made it.
if ! out="$(git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$signers" verify-tag "$tag" 2>&1)"; then
  stop tag-signature "\"$tag\" is not signed by an allowed release signer"
fi
fingerprint="$(grep -oE 'SHA256:[A-Za-z0-9+/=]+' <<<"$out" | head -1 || true)"
echo "ok   [tag-signature] signed with ${fingerprint:-unknown key}"

# Layer 5: the tagged commit has been merged to main.
git merge-base --is-ancestor "refs/tags/$tag^{commit}" "$main_ref" ||
  stop tag-on-main "\"$tag\" points at a commit that is not on $main_ref"
echo "ok   [tag-on-main]"
