# Configuration

stardust reads one file, `stardust.yaml` (path in `STARDUST_CONFIG`). Unknown
keys are errors, every problem is reported at once with its path, and a
process with an invalid configuration does not start.

**Secrets are references, never values.** Wherever a secret goes, write
`{ env: NAME }` or `{ file: /path }`. A plain string is rejected.

```yaml
version: 1

server:
  host: 0.0.0.0
  port: 8080
  publicUrl: https://stardust.example.com
  # Bearer token for /api/v1 and the dashboard sign-in, until user accounts
  # exist. Without it the admin API is off.
  adminToken: { env: STARDUST_ADMIN_TOKEN }

database:
  url: { env: DATABASE_URL }

plugins:
  # Each key enables one plugin.
  source-github: { ... }
  builder-buildkit: { ... }
  gitops-git: { ... }
```

## Plugins

### `source-github`

Receives push and pull-request webhooks at
`POST /webhooks/github/<project>` and works out what changed. Works with
GitHub and with hosts that send GitHub-compatible webhooks, such as Gitea.

| Key                   |          |                                                                                  |
| --------------------- | -------- | -------------------------------------------------------------------------------- |
| `webhookSecret`       | required | Secret the webhook is signed with.                                               |
| `token`               | one of   | Token for the compare API (a GitHub or Gitea token).                             |
| `appId`, `privateKey` | one of   | GitHub App credentials. _Not implemented yet; use `token`._                      |
| `apiBaseUrl`          | optional | Defaults to `https://api.github.com`; Gitea: `https://gitea.example.com/api/v1`. |

### `builder-buildkit`

Builds images in Kubernetes Jobs with rootless BuildKit. Requires
`builds.enabled: true` in the Helm chart so the worker may create Jobs in
the builds namespace.

| Key                |          |                                                                                        |
| ------------------ | -------- | -------------------------------------------------------------------------------------- |
| `namespace`        | required | Namespace the build Jobs run in.                                                       |
| `registry`         | required | Registry host and optional path. Images are `<registry>/<project>/<component>`.        |
| `cloneSecret`      | required | Secret in `namespace` with key `token`: reads the source repository.                   |
| `pushSecret`       | required | Secret in `namespace` with key `config.json`: a docker config that can push.           |
| `gitBaseUrl`       | optional | Git host to clone from. Defaults to `https://github.com`.                              |
| `cloneUsername`    | optional | User name sent with the clone token. GitHub ignores it; Gitea needs the token's owner. |
| `insecureRegistry` | optional | Push over plain HTTP. For local test registries only.                                  |

The clone runs in its own container; the build container, which runs the
Dockerfile, never sees the clone token.

### `gitops-git`

Writes desired state to a deploy repository with compare-and-swap commits,
so concurrent writers never overwrite each other.

| Key                  |          |                                                                                                                                                               |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                | required | `https://…` (no credentials in the URL), `file://…` or a path.                                                                                                |
| `branch`             | required | Branch the GitOps controller watches.                                                                                                                         |
| `token`              | optional | Token for pushing.                                                                                                                                            |
| `username`           | optional | User name sent with the token. Defaults to `x-access-token`.                                                                                                  |
| `buildRevAnnotation` | optional | Annotation key (for example `example.com/build-rev`). Where a manifest already carries it, it is set to the job id so a rebuild of the same commit rolls out. |

## Projects

A project is registered through the admin API:

```sh
curl -X PUT https://stardust.example.com/api/v1/projects/demo \
  -H "Authorization: Bearer $STARDUST_ADMIN_TOKEN" -H 'content-type: application/json' -d '{
    "name": "Demo",
    "githubRepo": "acme/demo",
    "pipelineDef": {
      "on": { "push": { "branches": ["main"] } },
      "jobs": { "api": { "pipeline": "C", "component": "api", "if": { "paths": ["api/**"] } } }
    },
    "components": [{ "name": "api", "pipeline": "C", "context": "api", "deployDir": "deploy/demo/api" }]
  }'
```

Then point the repository's webhook at
`https://stardust.example.com/webhooks/github/demo` with the
`webhookSecret`, for push events.

Every manifest in `deployDir` that references
`<registry>/demo/api:<tag>` is updated to the new build, pinned by digest.
