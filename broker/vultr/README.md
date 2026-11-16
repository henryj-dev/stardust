# Vultr API key broker

A minimal relay that is the only place the Vultr API key lives.

## Why it exists

A Vultr personal access token has full access to the whole account; Vultr offers no scoped
keys. If stardust held the key, any vulnerability in stardust (which receives webhooks,
serves the dashboard and talks to Kubernetes, GitHub and its database) would hand over the
entire Vultr account. The key cannot be narrowed, so it is kept here, in a service with as
little surface as possible, behind an allowlist of operations.

> The broker is trusted not because it is safe but because it is small enough to audit. It
> concentrates the key rather than moving it, so every line added weakens that case.

## Contract

The caller sends the same path, method and body it would send to Vultr. Only the base URL
and the auth header differ:

```
Vultr:   https://api.vultr.com/v2/instances      Authorization: Bearer <Vultr API key>
Broker:  http://<broker>:8080/instances          Authorization: Bearer <VULTR_BROKER_TOKEN>
```

The response status and body come back unchanged, so the caller's parsing does not change.
`GET /healthz` needs no token; every other path does, and a missing or wrong token is a 401
before any other check runs.

## Three layers of checks

All decisions are in `src/policy.ts`, a pure module; `src/index.ts` only asks it and relays.

| Layer | What is checked                                                                | On failure                                                 |
| ----- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 1     | Path and method against an anchored allowlist of the endpoints the caller uses | 403 (400 for a malformed path)                             |
| 2     | Body keys of `PATCH /instances/{id}`, and the value of `plan`                  | 400 for a forbidden key, 403 for an unlisted plan          |
| 3     | A signed, single-use approval ticket for `DELETE /instances/{id}`              | 403; 409 if already used; 503 if the ledger is unavailable |

**Layer 2.** Besides `user_data` and `firewall_group_id`, Vultr's endpoint accepts billing
changes (`backups`), OS reinstalls that destroy the disk (`os_id`, `image_id`, `app_id`) and
network detachment (`detach_vpc`). Allowing the path would allow all of that. Forbidden keys
are rejected, not filtered: dropping them silently would make the caller believe they were
applied. `plan` is allowed for resizing, but only with a value from an explicit list, which
acts as the billing ceiling.

**Layer 3.** The `X-Delete-Approval` header must carry a ticket signed with
`VULTR_DELETE_APPROVAL_TOKEN`, bound to the instance being deleted, valid for at most five
minutes, and usable once. Single use is enforced by a PostgreSQL ledger
(`migrations/001_approval_replay.sql`), so it holds across replicas and restarts. The ledger
is connected lazily and only on this path: if it is down, only deletes are refused.

There is deliberately no rollback ticket that would let a failed create delete its own
instance without approval. The caller's create flow has no automatic rollback (a failed
create is recorded and the instance is left for a person to clean up), so such a ticket
would have no user and would only add a way to delete instances that nobody approved.

## Environment

| Variable                          | Required    | Purpose                                                                            |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `VULTR_BROKER_TOKEN`              | yes         | Shared token the caller sends as `Authorization: Bearer`                           |
| `VULTR_API_KEY`                   | yes         | The Vultr API key. It lives only here.                                             |
| `VULTR_DELETE_APPROVAL_TOKEN`     | yes         | Key that signs and verifies delete approval tickets                                |
| `VULTR_REPLAY_DATABASE_URL`       | for deletes | PostgreSQL URL of the single-use ledger                                            |
| `PORT`                            | no          | Listen port, default 8080                                                          |
| `BUILD_SHA`                       | no          | Reported by `/healthz`                                                             |
| `VULTR_APPROVAL_REPLAY_IN_MEMORY` | tests only  | `1` uses an in-process ledger, but only while `VULTR_REPLAY_DATABASE_URL` is unset |

The broker refuses to start if any required variable is missing.

The ledger's database role needs only `SELECT, INSERT, UPDATE, DELETE` on
`vultr_broker_approval_replays`; apply the migration separately with a role that can create it.

## Deployment

- Do not mount a Kubernetes service account token: the broker does not use the Kubernetes API.
- Allow ingress only from stardust; allow egress only to `api.vultr.com`, DNS and the ledger
  database. Blocking every other egress is the point.
- Replicas are safe to add: the ledger is shared, so a ticket cannot be used twice.

## Image

Every release publishes the broker for `linux/amd64` and `linux/arm64`, built by the same
release workflow as the other stardust images, signed with cosign (keyless) and attested:

```
ghcr.io/henryj-dev/stardust-vultr-broker:<version>
```

The release workflow runs the broker's tests (the `test` stage) before it pushes, so a
published image has passed them. The image is **not** part of the Helm chart and never will
be: the broker holds the Vultr key and is a separate trust boundary, so deploy it with your
own manifests, in its own namespace if you can.

**Pin it by digest.** A tag can be moved; a digest cannot. Each GitHub release lists the
broker's digest in its Artifacts table. You can also resolve and verify a tag in one step:
`cosign verify` (below) prints the digest it verified. Reference the image by that digest:

```yaml
image: ghcr.io/henryj-dev/stardust-vultr-broker:<version>@sha256:<digest>
```

**Verify the signature** before deploying a new digest:

```bash
cosign verify ghcr.io/henryj-dev/stardust-vultr-broker@sha256:<digest> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/henryj-dev/stardust/\.github/workflows/release\.yml@refs/heads/main$'
```

An admission or GitOps verifier (for example Flux's OCI verification or a cosign policy)
should use the same issuer and identity regexp. The regexp is anchored: it accepts only the
release workflow on `main`, not other workflows, branches or forks. The build provenance
attestation can be checked with
`gh attestation verify oci://ghcr.io/henryj-dev/stardust-vultr-broker@sha256:<digest> --repo henryj-dev/stardust`.

To build the image yourself, from the repository root:

```bash
docker build -f broker/vultr/Dockerfile --target test .   # the tests
docker build -f broker/vultr/Dockerfile .                 # the runtime image
```

## Audit log

Each request logs one line with the verdict, method, path, status and reason. Request and
response bodies are never logged: a Vultr instance's `kvm` field holds a console URL with a
token in it, and `user_data` carries node report tokens. The log must not become a
credential store.

## Development

```bash
pnpm install
node --test "broker/vultr/src/**/*.test.ts"
DATABASE_URL_TEST=postgres://... node --test "broker/vultr/src/**/*.dbtest.ts"
node broker/vultr/src/main.ts
```

The tests are the substance of this service. They pin what is blocked, not style: endpoints
outside the allowlist (account, billing, users, snapshots), anchors that cannot be bypassed
(`/instances/{id}/reinstall`), each forbidden `PATCH` key, each way a delete approval can
fail, and the absence of credentials in the audit log.
