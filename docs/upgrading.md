# Upgrading

stardust is released as one version: the chart and the three images it pins
by digest. Upgrading means installing a newer chart; everything else follows
from it.

## Before you upgrade

1. Read the [changelog](../charts/stardust/CHANGELOG.md) from your version to
   the new one. Until 1.0, a minor version may change behaviour or
   configuration; each entry says what changed.
2. Back up the database. Migrations only go forward: going back to an older
   version after a newer one has migrated the database means restoring that
   backup.
3. Check the new chart's signature, as for a first install (Flux does this for
   you when the `OCIRepository` has `verify` set; see
   [releasing.md](releasing.md) for `cosign verify`).

## With Flux

Widen or move the version range of the `OCIRepository`:

```yaml
spec:
  ref:
    semver: ">=0.1.0 <1.0.0" # or pin one version: semver: "0.2.0"
```

Flux fetches the new chart, verifies its signature and upgrades the
`HelmRelease`. Check that it took:

```sh
kubectl -n stardust get ocirepository stardust   # the new version, SourceVerified=True
kubectl -n stardust get helmrelease stardust     # "Helm upgrade succeeded … stardust@<version>"
kubectl -n stardust get pods                     # new pods Running
```

## With Helm

```sh
helm upgrade stardust oci://ghcr.io/henryj-dev/charts/stardust --version 0.2.0 \
  --namespace stardust --reuse-values
```

## What happens on start

The server and the worker apply pending database migrations when they start,
in one transaction under an advisory lock, so several pods starting together
apply each migration exactly once. A pod whose migrations fail does not start;
the previous pods keep running until the new ones are ready.

## Upgrade notes

- **0.1.x → 0.2.0**: no configuration changes. New API endpoints only
  (reading projects and users, changing users, planning a delivery).
- **0.0.x → 0.1.0**: `server.adminToken` is gone. Configure
  `server.bootstrapAdmin` (see [configuration.md](configuration.md)) and sign
  in as that user. A pipeline definition without an `on` block now runs only
  for pushes to the default branch, and pull requests are built but not
  deployed.

This page was checked by doing it: a testbed installed with Flux went from
0.1.1 to 0.2.0 by changing only the version range above.
