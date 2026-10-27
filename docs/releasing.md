# Releasing

Releases follow [ADR 0002](adr/0002-release-trust.md): a release is a signed
tag, and everything built from it is signed by the release workflow.

## One-time setup

1. **Create one signing key per device that may release.** Any of them can
   sign a release, so a lost or broken key never blocks one. Hardware keys
   are preferred; keep at least two so one can be lost.

   On each security key (`-O resident` stores the key on the device so it can
   be used from another machine with `ssh-keygen -K`; `-O verify-required`
   asks for the device PIN as well as a touch):

   ```sh
   ssh-keygen -t ed25519-sk -O resident -O verify-required \
     -O application=ssh:stardust-release -C "stardust release: key A" \
     -f ~/.ssh/stardust-release-a
   ```

   A file key on a workstation works too, but it is the weakest of the set:
   anything that runs as you while it is unlocked can sign. Give it a
   passphrase.

   ```sh
   ssh-keygen -t ed25519 -C "stardust release: workstation" -f ~/.ssh/stardust-release-ws
   ```

2. **Register the public keys as the allowed signers.** In the repository
   settings, add an Actions variable `RELEASE_SIGNERS` holding the `.pub`
   files' lines, one per line. Blank lines and `#` comments are allowed, so
   label each key. It is a variable, not a file in the repository, so a pull
   request cannot change who may release.

   ```text
   # key A
   sk-ssh-ed25519@openssh.com AAAA... stardust release: key A
   # key B
   sk-ssh-ed25519@openssh.com AAAA... stardust release: key B
   # workstation
   ssh-ed25519 AAAA... stardust release: workstation
   ```

3. **Protect release tags.** Add a tag ruleset for `v*` that restricts
   creation, update and deletion to maintainers.

4. **Configure git to sign tags with SSH**, and pick the key per tag:

   ```sh
   git config gpg.format ssh
   git config user.signingkey ~/.ssh/stardust-release-a     # default key
   git -c user.signingkey=~/.ssh/stardust-release-b tag -s ...  # another one
   ```

## Cutting a release

```sh
git switch main && git pull --ff-only
git tag -s v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The `release` workflow then:

1. stops unless the tag is `vMAJOR.MINOR.PATCH[-PRERELEASE]`, annotated,
   signed by one of `RELEASE_SIGNERS`, and on `main` — each check reports its
   own name, and the log records the fingerprint of the key that signed
   (`tools/verify-release-tag.sh`);
2. builds `stardust-server`, `stardust-worker` and `stardust-web` for amd64 and
   arm64, pushes them to GHCR, signs them with cosign and attaches an SBOM
   and build provenance;
3. writes the image digests into the chart, checks that all three images are
   pinned, pushes the chart to `oci://ghcr.io/henryj-dev/charts/stardust` and
   signs it;
4. creates a GitHub release listing every digest.

## Verifying a release

```sh
cosign verify ghcr.io/henryj-dev/charts/stardust:0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/henryj-dev/stardust/.github/workflows/release.yml@refs/tags/v0.1.0
```

With Flux, put the same identity in the `OCIRepository`:

```yaml
spec:
  url: oci://ghcr.io/henryj-dev/charts/stardust
  ref:
    semver: ">=0.1.0"
  verify:
    provider: cosign
    matchOIDCIdentity:
      - issuer: ^https://token\.actions\.githubusercontent\.com$
        subject: ^https://github\.com/henryj-dev/stardust/\.github/workflows/release\.yml@refs/tags/v.*$
```

## Adding, losing or replacing a key

- **Add a key:** create it as above and add its line to `RELEASE_SIGNERS`.
- **Lose a key:** delete its line. Releases continue with the remaining keys.
  Artifacts already released stay valid: their signatures come from the
  release workflow, not from the tag key.
- **Suspect a key was compromised:** delete its line, delete any tag you did
  not create, and review the release runs since the last tag you trust — each
  run's log names the fingerprint that signed it.
