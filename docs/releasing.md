# Releasing

stardust releases with [changesets](https://github.com/changesets/changesets),
the same flow as cloudflare/workers-sdk. See [ADR 0002](adr/0002-release-trust.md)
for why.

## Contributors: add a changeset

Every pull request that changes behaviour adds a changeset:

```sh
pnpm changeset
```

Pick `stardust` (it is the only package that is released), choose the bump and
write one or two sentences for the changelog. Commit the generated file in
`.changeset/` with your change. Pull requests that only touch tests, CI or
docs do not need one.

While stardust is below 1.0, use `minor` for anything that changes behaviour
or configuration and `patch` for fixes.

## Maintainers: release

1. Merge pull requests as usual. After each merge, the `release` workflow
   opens or updates a pull request titled **chore: version packages**. It
   bumps `charts/stardust/package.json` and adds the changesets to
   `charts/stardust/CHANGELOG.md`.
2. When you want to release, **merge that pull request.**
3. The workflow sees a version that has not been released and:
   1. builds `stardust-server`, `stardust-worker` and `stardust-web` for amd64
      and arm64, pushes them to GHCR, signs them with cosign and attaches an
      SBOM and build provenance (GitHub-stored attestations are added once the
      repository is public; the free plan does not offer them for private ones);
   2. writes the image digests into the chart, checks that all three images
      are pinned, pushes the chart to `oci://ghcr.io/henryj-dev/charts/stardust`
      and signs it;
   3. creates the tag `vX.Y.Z` and a GitHub release with the changelog and
      every digest.

The tag is created last, so a failed build leaves no tag; re-running the
workflow or pushing again retries the release.

## Verifying a release

```sh
cosign verify ghcr.io/henryj-dev/charts/stardust:0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/henryj-dev/stardust/.github/workflows/release.yml@refs/heads/main
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
        subject: ^https://github\.com/henryj-dev/stardust/\.github/workflows/release\.yml@refs/heads/main$
```

## Repository settings the flow needs

- **Actions → General → Workflow permissions:** "Allow GitHub Actions to create
  and approve pull requests" must be on, or the version pull request cannot be
  opened. The default token permission stays read-only; the workflow asks for
  write access only in the jobs that need it.
- Pull requests opened by the workflow's token do not trigger other workflows,
  so CI does not run on the version pull request. It only changes the version
  and the changelog; CI runs on `main` after the merge.
