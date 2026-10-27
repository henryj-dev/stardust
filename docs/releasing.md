# Releasing

Releases follow [ADR 0002](adr/0002-release-trust.md): a release is a signed
tag, and everything built from it is signed by the release workflow.

## One-time setup

1. **Create a release signing key** on the maintainer's machine. A hardware
   key (`ed25519-sk`) is preferred; a passphrase-protected file key works too.

   ```sh
   ssh-keygen -t ed25519-sk -C "stardust release" -f ~/.ssh/stardust-release
   ```

2. **Register the public key as the allowed signer.** In the repository
   settings, add an Actions variable `RELEASE_SIGNER_PUBKEY` whose value is the
   single line in `~/.ssh/stardust-release.pub`. It is a variable, not a file
   in the repository, so a pull request cannot change who may release.

3. **Protect release tags.** Add a tag ruleset for `v*` that restricts
   creation, update and deletion to maintainers.

4. **Configure git to sign tags with that key:**

   ```sh
   git config gpg.format ssh
   git config user.signingkey ~/.ssh/stardust-release.pub
   ```

## Cutting a release

```sh
git switch main && git pull --ff-only
git tag -s v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The `release` workflow then:

1. stops unless the tag is `vMAJOR.MINOR.PATCH[-PRERELEASE]`, annotated,
   signed by `RELEASE_SIGNER_PUBKEY`, and on `main` — each check reports its
   own name (`tools/verify-release-tag.sh`);
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

## Rotating or replacing the signing key

1. Create the new key as in the one-time setup.
2. Replace the value of `RELEASE_SIGNER_PUBKEY` with the new public key.
   Tags signed by the old key can no longer be released, but artifacts
   already released stay valid: their signatures come from the release
   workflow, not from the tag key.
3. Cut the next release with the new key.

If the key is lost, the steps are the same. If it may have been
compromised, also delete any tag you did not create and review the release
workflow runs since the last tag you trust.
