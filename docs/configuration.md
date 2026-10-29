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
  # The first administrator, created only while there are no users. Change the
  # password after signing in, and remove this once other administrators exist.
  bootstrapAdmin:
    username: admin
    password: { env: STARDUST_BOOTSTRAP_PASSWORD }

database:
  url: { env: DATABASE_URL }

plugins:
  # Each key enables one plugin.
  source-github: { ... }
  builder-buildkit: { ... }
  gitops-git: { ... }
```

## Accounts and access

- **Sign-in** is by username and password (`POST /api/v1/auth/login`). Ten
  failures in 15 minutes lock a username for that window. Sessions last 12
  hours.
- **Roles** are per project: `maintainer` changes it, `viewer` reads it.
  Administrators do everything. Someone who is not a member gets 404 for a
  project, so project names do not leak.
- **API tokens** (`sdt_…`) are for automation. Create one with
  `POST /api/v1/tokens` `{"name": "ci", "expiresInDays": 90}`; it is shown
  once and acts with your roles. List with `GET /api/v1/tokens`, revoke with
  `DELETE /api/v1/tokens/<id>`.
- **Single sign-on** through any OpenID Connect provider:

  ```yaml
  plugins:
    identity-oidc:
      displayName: Company SSO          # the sign-in button
      issuer: https://id.example.com
      clientId: stardust
      clientSecret: { env: OIDC_CLIENT_SECRET }
      allowedGroups: [developers]       # optional: only these groups may sign in
      adminGroups: [platform]           # optional: these are administrators, checked at every sign-in
      autoCreate: true                  # optional: create an account at first sign-in (default false)
  ```

  Register `<server.publicUrl>/login/oidc/callback` as the redirect URI. The
  flow uses PKCE, a nonce and a one-time state bound to the browser, and the
  ID token's signature is checked against the provider's keys. People are
  matched by issuer and subject only. A first sign-in whose username already
  belongs to another account is refused, never linked to it. Without
  `autoCreate`, an administrator creates the account first:
  `POST /api/v1/users {"username": "ada", "oidc": {"issuer": "…", "subject": "…"}}`.
- **Lost password.** Anyone who can reach the deployment can reset it, and
  that access is the authority for it:

  ```sh
  kubectl -n stardust exec -i deploy/stardust-server -- \
    node packages/server/src/admin.ts reset-password admin < new-password.txt
  ```

  The password is read from standard input, so it does not appear in the
  process list or shell history. The user's sessions end.

## Plugins

### `source-github`

Receives push and pull-request webhooks at
`POST /webhooks/github/<project>` and works out what changed, and resolves
what a [manual run](#manual-runs) builds. Webhooks work with GitHub and with
hosts that send GitHub-compatible webhooks, such as Gitea; manual runs need
GitHub's API.

| Key                   |          |                                                                                                       |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `webhookSecret`       | optional | Secret the webhook is signed with. Without it no webhook is accepted: runs start only when asked for. |
| `token`               | optional | Token for the source host's API (a GitHub or Gitea token). Without one, public repositories only.     |
| `appId`, `privateKey` | optional | GitHub App credentials, instead of `token`. _Not implemented yet._                                    |
| `apiBaseUrl`          | optional | Defaults to `https://api.github.com`; Gitea: `https://gitea.example.com/api/v1`.                      |

Without a token, GitHub's API answers anonymously at a lower rate limit
(60 requests an hour per address); a manual run uses one to three.

### `builder-buildkit`

Builds images in Kubernetes Jobs with rootless BuildKit. Requires
`builds.enabled: true` in the Helm chart so the worker may create Jobs in
the builds namespace.

| Key                |          |                                                                                                                                    |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`        | required | Namespace the build Jobs run in.                                                                                                   |
| `registry`         | required | Registry host and optional path. Images are `<registry>/<project>/<component>`.                                                    |
| `cloneSecret`      | optional | Secret in `namespace` with key `token`: reads the source repository. Without it the clone is anonymous (public repositories only). |
| `pushSecret`       | required | Secret in `namespace` with key `config.json`: a docker config that can push.                                                       |
| `gitBaseUrl`       | optional | Git host to clone from. Defaults to `https://github.com`.                                                                          |
| `cloneUsername`    | optional | User name sent with the clone token. GitHub ignores it; Gitea needs the token's owner.                                             |
| `insecureRegistry` | optional | Push over plain HTTP. For local test registries only.                                                                              |

The clone runs in its own container; the build container, which runs the
Dockerfile, never sees the clone token.

### `gitops-git`

Writes desired state to a deploy repository with compare-and-swap commits,
so concurrent writers never overwrite each other.

| Key                  |          |                                                                                                                                                                 |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                | required | `https://…` (no credentials in the URL), `file://…` or a path.                                                                                                  |
| `branch`             | required | Branch the GitOps controller watches.                                                                                                                           |
| `token`              | optional | Token for pushing.                                                                                                                                              |
| `username`           | optional | User name sent with the token. Defaults to `x-access-token`.                                                                                                    |
| `buildRevAnnotation` | optional | Annotation key (for example `example.com/build-rev`). Where a manifest already carries it, it is set to the job id so a rebuild of the same commit rolls out.   |
| `githubApp`          | optional | Push as a GitHub App instead of with `token`: `appId`, `privateKey` (a reference) and optionally `apiBaseUrl`. Needs a `https://github.com/<owner>/<name>` url. |

With `githubApp`, stardust finds the App's installation on the deploy
repository and asks for installation tokens narrowed to that repository and
to `contents: write`, whatever else the installation grants. A token lasts an
hour and is renewed five minutes before it expires. Install the App on the
deploy repository only, with "Contents: Read and write".

## Projects

A project is registered through the API, by an administrator (with a session
or an API token, see [Accounts and access](#accounts-and-access)):

```sh
curl -X PUT https://stardust.example.com/api/v1/projects/demo \
  -H "Authorization: Bearer $STARDUST_TOKEN" -H 'content-type: application/json' -d '{
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
`webhookSecret`, for push events — or deliver it only by asking, see
[Manual runs](#manual-runs).

Every manifest in `deployDir` that references
`<registry>/demo/api:<tag>` is updated to the new build, pinned by digest.

### Components

| Pipeline | Builds                                  | Fields                                                                           |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `C`      | the repository's own Dockerfile         | `context` (default the root), `dockerfile` (default `Dockerfile` in the context) |
| `N`      | a Node application without a Dockerfile | `context`, `port` (default 3000), `buildEnv`                                     |

A pipeline `N` build installs with pnpm whatever lockfile the app carries
(install scripts do not run), runs the `build` script, and starts `server.js`
with node if the app has one, otherwise `build/index.js` (the SvelteKit
`adapter-node` layout). `buildEnv` is set during the build only, for choices a
build compiles in, such as an adapter; it is not for secrets.

The lockfile decides how pnpm installs:

| Lockfile                                                | Install                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                        | as it is (`--frozen-lockfile`)                                                                     |
| `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` | turned into `pnpm-lock.yaml` by `pnpm import`, keeping its versions; if that fails, resolved fresh |
| `bun.lock`, `bun.lockb`, or none                        | resolved fresh from `package.json`                                                                 |
| lockfiles of more than one package manager              | the build stops: keep one                                                                          |

The build log names the way taken (`[node-build] install: …`). pnpm is pinned
(12.14.0) unless the app's `packageManager` names a pnpm version of its own.

```json
{
  "name": "web",
  "pipeline": "N",
  "context": "web",
  "port": 3000,
  "buildEnv": { "BUILD_TARGET": "node" },
  "deployDir": "deploy/demo/web"
}
```

Check a definition before saving it with `POST /api/v1/projects/<id>/plan`,
which reports what a delivery would run without running it.

### Manual runs

A maintainer of a project (or an administrator) can ask for a commit to be
built and delivered, from the project's page ("Pull and deliver") or the API:

```sh
curl -X POST https://stardust.example.com/api/v1/projects/demo/runs \
  -H "Authorization: Bearer $STARDUST_TOKEN" -H 'content-type: application/json' \
  -d '{"tag": "v2.7.0"}'
```

The body names at most one of `branch`, `tag` or `sha` (a full commit hash);
an empty body takes the head of the default branch. A commit given by hash
must be in the default branch's history. The run records who asked for it.
Its definition's `on` block and path filters do not apply: every job runs,
and the result is delivered.

Set `"webhookKind": "off"` on a project to refuse its webhooks altogether.
That is the safe way to deliver a public repository, or one you do not
control: nothing reaches your cluster until someone asks for a specific
commit, and pinning a tag says exactly which one.

| `webhookKind`    | Webhooks                                              |
| ---------------- | ----------------------------------------------------- |
| `repo` (default) | accepted; the repository is the project's own         |
| `workspace`      | accepted; a monorepo shared with other projects       |
| `off`            | ignored; the project is delivered by manual runs only |
