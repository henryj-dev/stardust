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

audit:
  retentionDays: 365 # optional; see "Audit log"

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

## Audit log

stardust records who did what: sign-ins (and failed ones), sign-outs, users
created and changed, password resets, API tokens made and revoked, projects
created and changed, membership changes, and runs started. An event names the
actor (the user, and the API token when one was used), the action
(`project.update`), the project and target, and a detail that names things —
fields, components, keys — and never holds a password, token or secret value.

```yaml
audit:
  retentionDays: 365 # the worker removes older events every hour; 0 keeps them all
```

- Administrators read the whole log in the dashboard (**Audit log** in the
  header) or with `GET /api/v1/audit?actor=&action=&project=&since=&until=&limit=`.
  `action` may be a dotted prefix (`project` matches `project.member.set`).
  Results are newest first; pass the response's `next` as `before` for the
  next page.
- A project's maintainers read that project's events at
  `/projects/<id>/audit` (`GET /api/v1/projects/<id>/audit`). Viewers do not:
  the log says who changed what.
- A failed sign-in names the username only when that user exists, since
  people type passwords into the username field.
- Each event keeps the address the server saw, and the address and user agent
  the dashboard passes on for the browser. They are not verified. Behind a
  reverse proxy, set the dashboard's `ADDRESS_HEADER` (and `XFF_DEPTH`) so it
  passes on the browser's address rather than the proxy's.

## Plugins

### `source-github`

Resolves what a [run](#runs) builds: the head of a branch, a tag, or a
commit, through GitHub's API or a GitHub-compatible one such as Gitea's.
Branches and the default branch work with both; tags and commit hashes are
known to work with GitHub only (Gitea's compare API does not say whether a
commit is in a branch's history, so a hash is refused there). stardust takes
no webhooks: nothing is built until someone asks.

| Key                   |          |                                                                                                   |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `token`               | optional | Token for the source host's API (a GitHub or Gitea token). Without one, public repositories only. |
| `appId`, `privateKey` | optional | GitHub App credentials, instead of `token`. _Not implemented yet._                                |
| `apiBaseUrl`          | optional | Defaults to `https://api.github.com`; Gitea: `https://gitea.example.com/api/v1`.                  |

A `webhookSecret` left over from an older configuration is ignored (the
server logs that it is), so upgrading needs no edit.

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

### `secrets-sops-age`

Encrypts secrets in the deploy repository with [SOPS](https://getsops.io)
and age. With it and `gitops-git` both configured, and the identity mounted,
the server lets maintainers edit env and secrets (see "Environment and
secrets").

- `ageKeyFile` (required): path of the age identity file. The chart mounts
  it at `/run/secrets/age/keys.txt`.
- `recipients` (required): age public keys new secrets are encrypted for.
  Include the identity itself.
- `sopsBinary` (optional): path of `sops`. The server image has it on `PATH`.

## Environment and secrets

A project's runtime environment lives in env layers in the deploy repository,
in the layout stardust has always read:

```
deploy/env/<project>/_shared/runtime.yaml               plain values, every component
deploy/env/<project>/_shared/runtime.secret.enc.yaml    SOPS-encrypted values, every component
deploy/env/<project>/<component>/runtime.*              one component's own
deploy/env/_global/runtime.*                            every project (read, not edited here)
```

From the layers stardust renders, in each component's `deployDir`,
`env.configmap.yaml` (ConfigMap `<component>-env`) and `env.secret.enc.yaml`
(Secret `<component>-env-secret`, encrypted), and lists both in the
directory's `kustomization.yaml`. Use them from the workload with `envFrom`.

- **Reading** (`/projects/<id>/env`, `GET /api/v1/projects/<id>/env`) is for
  anyone who can read the project: plain values, and the **names** of
  secrets. A secret's value is never shown or returned again once saved.
- **Changing** is for the project's maintainers and administrators, one layer
  at a time (`PATCH /api/v1/projects/<id>/env/<layer>` with `set`, `unset`,
  `setSecrets`, `unsetSecrets` and the `expectedRevision` read). Each change is
  one commit: the layer, the rendered ConfigMap and Secret of every component
  that reads the layer, and the env revision in those workloads' pod template,
  so the GitOps controller rolls them out when it applies the commit. A layer
  that changed since it was read is refused (409), never overwritten.
  Setting values that are already there commits nothing.
- Names are environment variable names; a value is at most 32 KiB; one name is
  plain or secret within a layer, and setting it as one removes the other.
- Each change is in the audit log as `env.change`, with the names it touched.

To turn it on, give the server what it writes with:

1. `plugins.gitops-git` and its credentials (the server reads them like the
   worker: with the chart's `extraEnvFrom`, both get the same environment).
2. `plugins.secrets-sops-age` with `ageKeyFile: /run/secrets/age/keys.txt`
   and the recipients.
3. The age identity in a Secret, named in the chart's
   `envEditing.ageKeySecret` (key `keys.txt` by default). Only the server
   mounts it.

## Projects

A project is registered through the API, by an administrator (with a session
or an API token, see [Accounts and access](#accounts-and-access)):

```sh
curl -X PUT https://stardust.example.com/api/v1/projects/demo \
  -H "Authorization: Bearer $STARDUST_TOKEN" -H 'content-type: application/json' -d '{
    "name": "Demo",
    "githubRepo": "acme/demo",
    "pipelineDef": {
      "jobs": { "api": { "pipeline": "C", "component": "api" } }
    },
    "components": [{ "name": "api", "pipeline": "C", "context": "api", "deployDir": "deploy/demo/api" }]
  }'
```

Then deliver it by asking for a run, see [Runs](#runs).

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

### Runs

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
Every job of the definition runs, and the result is delivered.

This is the only way a run starts. A merge, even to a public repository you do
not control, reaches your cluster only when someone asks for a specific commit,
and pinning a tag says exactly which one.

A definition may still carry an `on` block and `if.paths` filters from an
older installation; they are accepted and have no effect.
