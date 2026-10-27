# 0001 — Scope and plugin model

- Status: Proposed
- Date: 2026-10-27

## Context

stardust grew out of a single internal control plane that did everything for
one environment: builds, GitOps writes, secrets, database provisioning,
certificates, cloud instances, DNS and node telemetry, all in one process with
the environment's names written into the code. That shape cannot be installed
by anyone else, and it has no boundary that says what stardust _is_.

The maintainer runs the public release as-is in production. That is only
possible if the public repository contains everything production needs and
nothing that only makes sense in one environment.

## Decision

1. **Core scope** is the delivery path and what it needs: source events →
   in-cluster builds → desired state committed to a deploy repository →
   applied by a GitOps controller; the environment/secret cascade; identity,
   RBAC and audit; runtime observation of what was deployed; the dashboard.
2. **Everything else is a plugin**: source hosts, builders, GitOps targets,
   secret backends, identity providers, DNS, clouds, databases, certificates,
   node agents. Plugins live in this repository, are compiled into the binary
   and are enabled in `stardust.yaml`. There is no dynamic loading.
3. **A plugin depends only on `packages/core`** and never on another plugin.
   Shared code moves to core. These rules are enforced by
   `.dependency-cruiser.cjs`, each with a fixture that proves it can fail.
4. **No environment-specific code.** Hostnames, address ranges, cluster names
   and account names enter through configuration only. A deployment keeps
   values (configuration, Helm values, encrypted secrets) and no code; when a
   deployment needs code, it is contributed here.

The test for any change: _would this be accepted from a stranger?_

## Consequences

- Plugins compiled in make the image larger than strictly needed, but there
  is one artifact to sign and verify, and no plugin/version skew.
- Integrations the maintainer needs but few others do still ship here, off by
  default. That is a maintenance cost accepted in exchange for running the
  exact public release.
- Supported combinations are stated explicitly (see the README) instead of
  generalising every assumption up front.
