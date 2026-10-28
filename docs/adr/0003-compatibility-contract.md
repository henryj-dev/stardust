# 0003 — Compatibility with existing deployments

- Status: Accepted (2026-10-28)
- Date: 2026-10-27

## Context

stardust is rebuilt from a predecessor system that already manages live
projects. The rebuild has to replace it without re-creating every project by
hand, but carrying its internals forward would carry its problems too.

## Decision

The formats other systems depend on are kept; internal implementation is not.

**Kept** (read and written unchanged):

- The deploy repository layout, including the per-project environment layer
  directory and its file format.
- The pipeline definition document format. A version field is added so a
  future format can be introduced without guessing.
- Webhook signing secrets of source hosts, OIDC client registrations, and
  SOPS/age recipients — moved without re-issuing anything.
- The node agent wire protocol, defined by the Go agent and tested with golden
  frames.

**Replaced:**

- The database schema starts from a new baseline. Moving existing data is a
  one-off import performed by the operator, outside this repository.
- The HTTP API is redesigned under `/api/v1`, described by OpenAPI, and
  consumed through the generated client. There is no compatibility proxy for
  the old routes.
- Environment-variable configuration is replaced by `stardust.yaml`.
- Webhook URLs. They are addressed by project id
  (`/webhooks/github/<project>`) rather than by repository name. The secret
  stays the same; only the URL in the source host changes.

## Consequences

- Existing deploy repositories keep working, and switching a project over is
  a configuration change rather than a migration of its manifests.
- Anything that called the old API directly must move to `/api/v1`.
- Each project's webhook URL is changed when that project is switched over,
  so the change of URL is the moment of switching. No route of the old system
  is kept for it.
- Format compatibility is checked by golden tests that render existing inputs
  and compare outputs by content hash.
