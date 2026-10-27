# 0002 — Release trust: signed tags, signed artifacts

- Status: Proposed
- Date: 2026-10-27

## Context

stardust holds credentials that can change a cluster and its deploy
repository. Anything a stardust deployment runs therefore needs a clear answer
to "who approved this exact build?". The project is public and accepts pull
requests, so "whatever is on `main`" is not an acceptable answer for
production. The project currently has a single maintainer, so approval cannot
rely on a second reviewer.

## Decision

1. **A release is a signed git tag** `vX.Y.Z`, signed with the maintainer's
   SSH release key. The release workflow refuses to continue unless
   - the tag signature verifies against the allowed signer, and
   - the tagged commit is an ancestor of `main`.
2. **The allowed signer lives outside the repository tree** (a repository
   variable), so a pull request cannot change the trust anchor. Tag creation
   for `v*` is restricted to maintainers by a ruleset.
3. **Builds run only on GitHub-hosted runners.** Release images are pushed to
   GHCR, signed with cosign keyless signing bound to the release workflow
   identity on that tag, and published with an SBOM and build provenance.
4. **The Helm chart is the unit of deployment.** The release workflow writes
   image digests into the chart's values, then pushes the chart as an OCI
   artifact and signs it. A signed chart therefore pins a signed set of images.
5. **Deployments verify before they apply.** The recommended setup is a Flux
   `OCIRepository` with `verify.provider: cosign` and `matchOIDCIdentity` set
   to this repository's release workflow, so the GitOps controller applies
   only charts produced by a signed release.
6. **Rollback is a revert** of the commit that bumped the release in the
   deployment repository. Older releases are signed too and verify the same way.

## Consequences

- An urgent fix needs merge → tag → release before it reaches production.
  The release pipeline must stay fast (target: under 15 minutes) or the
  pressure to bypass it wins.
- Losing the release key blocks releases until a new key is registered; the
  rotation procedure must be written down before the first release.
- Keyless signatures are recorded in the public Sigstore transparency log,
  including the repository and workflow identity.
