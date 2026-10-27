# 0002 — Release flow and artifact trust

- Status: Proposed
- Date: 2026-10-27

## Context

stardust holds credentials that can change a cluster and its deploy
repository, so a deployment needs a clear answer to "what exactly is this, and
did our release process produce it?". The project is public and accepts pull
requests. It should also release the way contributors already know from other
projects, without keys for people to manage.

## Decision

1. **Releases follow the changesets flow** used by projects such as
   cloudflare/workers-sdk. Pull requests carry changeset files. On every push
   to `main`, a bot opens or updates a "Version Packages" pull request with the
   version bump and changelog. **Merging that pull request is the release.**
2. **stardust is versioned as one product.** Changesets track a single package
   named `stardust` (`charts/stardust/package.json`); the internal `@stardust/*`
   packages are not released on their own. CI rejects a changeset that names
   anything else, because changesets would silently drop it.
3. **Builds run only on GitHub-hosted runners** in the release workflow on
   `main`. Images are pushed to GHCR, signed with cosign keyless signing bound
   to that workflow, and published with an SBOM and build provenance.
4. **The Helm chart is the unit of deployment.** The workflow writes the image
   digests into the chart's values, pushes the chart as an OCI artifact and
   signs it, so a signed chart pins a signed set of images. The git tag and the
   GitHub release are created last, only after every artifact exists.
5. **Deployments verify before they apply.** The recommended setup is a Flux
   `OCIRepository` with `verify.provider: cosign` and `matchOIDCIdentity` set
   to this repository's release workflow on `main`, so the GitOps controller
   applies only charts the release workflow produced.
6. **Rollback is a revert** of the commit that bumped the release in the
   deployment repository.

## Consequences

- Who may release is who may merge to `main`. The trust in a release rests on
  the maintainers' GitHub accounts, so those accounts should use hardware keys
  or passkeys. A stolen token with merge rights can release; this is the same
  trade-off most projects accept.
- With more than one maintainer, a GitHub Environment with required reviewers
  can be added in front of the build jobs to require a second person.
- Keyless signatures are recorded in the public Sigstore transparency log,
  including the repository and workflow identity.
