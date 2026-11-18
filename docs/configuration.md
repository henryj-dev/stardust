# Configuration

stardust reads one file, `stardust.yaml` (path in `STARDUST_CONFIG`). Unknown
keys are errors, every problem is reported at once with its path, and a
process with an invalid configuration does not start.

**Secrets are references, never values.** Wherever a secret goes, write
`{ env: NAME }` or `{ file: /path }`. A plain string is rejected.

```yaml
version: 1

# The region this installation serves (lower-case, required, no default).
region: eu-west

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
  globalUrl: { env: GLOBAL_DATABASE_URL } # optional: see "Several regions"

audit:
  retentionDays: 365 # optional; see "Audit log"

plugins:
  # Each key enables one plugin.
  source-github: { ... }
  builder-buildkit: { ... }
  gitops-git: { ... }
```

## Several regions

Each region (a cluster, a private network) runs its own stardust with its own
`region` and its own database for what happens there: runs, jobs, the
features' regional tables. Accounts, roles, projects and the audit log live
in one primary every region shares, `database.globalUrl`; left out, it is the
same database, which is how one region works.

- Every decision about access (sign-in, sessions, roles, tokens) reads the
  primary. When a region cannot reach it, such requests are refused, never
  allowed.
- Every region's database has the whole schema: the global tables there are
  copies, kept by logical replication from the primary (list the global
  tables in a publication, not all tables, and leave `schema_migrations`
  out). stardust writes global tables to the primary only.
- A project belongs to the region it was made in (`metadata.region`). Other
  regions show it but refuse to change it, answering 409 with the owner's
  name; a project from before regions can be changed anywhere.
- Features that act on shared things once (cloud instances, say) are turned
  on in one installation only: a plugin's section in `stardust.yaml` decides,
  so the others simply do not have those routes.

**One dashboard for all of them.** Give the web the other regions (Helm
`web.regions`, i.e. `STARDUST_REGIONS=name=https://…,…`, with
`STARDUST_HOME_REGION` set to its own). It keeps no state: the project list
and other shared things come from its own region, or the next that answers;
a project's runs, env and changes go to the region that owns it (and a
change another region refuses is sent on, once, to the owner it names). A
region that cannot be reached fails what belongs to it, and only that:
nothing is sent elsewhere instead.

```yaml
# values.yaml of the dev-ams installation
web:
  regions:
    prod-fra: https://stardust-api.fra.example.com
```

## Accounts and access

- **Sign-in** is by username and password (`POST /api/v1/auth/login`). Ten
  failures in 15 minutes lock a username for that window. Sessions last 12
  hours.
- **Accounts without email.** An administrator adds people on the Users page
  (`/admin/users`), which gives each new account a one-time invitation link;
  for a forgotten password it gives a reset link. A link works once, for 72
  hours, and a newer one replaces it; only its hash is stored, and it is shown
  only to the administrator who asked, to hand on. Setting a password through
  a link ends every session and API token of the account. People change their
  own password, and see and end their sessions, on `/account`; an
  administrator can end all of someone's sessions and tokens at once.
- **Two-step sign-in** for local accounts, with any authenticator app (TOTP,
  RFC 6238) and ten one-time recovery codes, set up on `/account`. A session
  from single sign-on has no second step here: that is the provider's.

  ```yaml
  auth:
    local:
      enabled: true # false: single sign-on only
      totp: optional # off | optional | required
      totpKey: { env: TOTP_KEY } # optional, 32+ characters: seals TOTP secrets in the database
    reauthMinutes: 10
  ```

  With `required`, a password session without TOTP can only set it up. Without
  `totpKey` the secrets are stored as they are (the server says so at start-up).
  An administrator can turn someone's TOTP off after a lost phone.
- **Confirming it is you.** Deleting a project, issuing a sign-in link,
  resetting someone's TOTP and creating an API token need a sign-in from the last `reauthMinutes`: the
  page asks for the password, or a code when TOTP is on
  (`POST /api/v1/account/reauth`). API tokens pass; they are credentials made
  for automation.
- **Roles** are per project: `maintainer` changes it, `viewer` reads it.
  Administrators do everything. Someone who is not a member gets 404 for a
  project, so project names do not leak.
- **API tokens** (`sdt_…`) are for automation. Create one with
  `POST /api/v1/tokens` `{"name": "ci", "expiresInDays": 90}`; it is shown
  once and acts with your roles. List with `GET /api/v1/tokens`, revoke with
  `DELETE /api/v1/tokens/<id>`. The Account page in the dashboard does the
  same.
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

  Optional `mfa: { requireAmr: [otp] }` refuses a sign-in whose `amr` claim
  lacks any of the listed values, so the provider's second step is required.

  Sessions follow the provider's both ways. Signing out of stardust sends the
  browser on to the provider's `end_session_endpoint` (register
  `<server.publicUrl>/login` as a post-logout redirect URI). For the other
  way, register the server's
  `/api/v1/auth/oidc/backchannel-logout` as the back-channel logout URI (it
  must be reachable from the provider): a signed logout token ends that
  provider session's stardust sessions, or all of the subject's; each token
  is accepted once. Confirming it is you, for a single sign-on session,
  means signing in again at the provider (`prompt=login`, `max_age=0`), and
  only a sign-in from the last five minutes counts.

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

Each key under `plugins:` enables one plugin. `GET /api/v1/capabilities`
lists the enabled plugins and what each adds; the dashboard uses it to show
only what this server has. A plugin's own API is under
`/api/v1/plugins/<plugin>/`, its tables are named `<plugin>_*`, and its
schedules run on one worker at a time (their last run and error are in the
`schedule_runs` table).

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
| `appId`, `privateKey` | optional | GitHub App credentials, instead of `token`: see below.                                            |
| `apiBaseUrl`          | optional | Defaults to `https://api.github.com`; Gitea: `https://gitea.example.com/api/v1`.                  |

A `webhookSecret` left over from an older configuration is ignored (the
server logs that it is), so upgrading needs no edit.

Without a token, GitHub's API answers anonymously at a lower rate limit
(60 requests an hour per address); a manual run uses one to three.

**Private repositories, with a GitHub App.** Give stardust an App of its own,
with _Contents: read_ and _Metadata: read_ only, installed on the private
repositories it builds (keep it apart from any App that writes your deploy
repository, so one leaked key never opens both). Each build then gets a token
for its repository alone, kept in a Secret owned by the build Job (made
before the Job runs, deleted with it) and seen by the clone step only. A
public repository needs no token; a private one the App is not installed on
is refused, never cloned anonymously. The worker needs `create` on secrets
and `patch` on jobs in the builds namespace (the chart grants both).

```yaml
source-github:
  appId: 123456
  privateKey: { file: /run/secrets/github-app.pem }
```

The project form's **Check access** says how stardust reads the repository
it names (also `GET /api/v1/source/access?repo=owner/name`, for
administrators): public, through the App, with the token, or not at all. It
warns when the App is installed on all of the owner's repositories rather than
the ones stardust builds.

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
| `pull`             | optional | `{ username, password: { env } }`: a read-only login pods pull with. stardust seals it into each component's directory (below).    |

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
| `envRoot`            | optional | Directory of the env layers in the repository. Defaults to `deploy/env`. See "Environment and secrets".                                                         |
| `deployDirTemplate`  | optional | Where a component's manifests go when it names no directory, e.g. `deploy/apps/{project}/{component}`. The project form fills it in as the names are typed.     |

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

### `runtime`

Shows what a component runs, on its page: each Deployment, StatefulSet and
DaemonSet in the component's deploy directory, its pods (phase, readiness,
restarts, node, container states) and recent events. Maintainers can restart
the component and change a workload's replicas or a container's resources.

```yaml
runtime: {}
```

Every change is a commit to the deploy repository, applied by the GitOps
controller, so it is not reverted as drift: a restart writes the pod-template
annotation `stardust.dev/restarted-at`. Changes are audited as
`runtime.restart`, `runtime.scale` and `runtime.resources`. The workloads'
namespace is the one in their manifests, or the kustomization's.

The server reads the cluster with its own service account. List the
namespaces in the chart's `runtime.namespaces`: each gets a read-only Role
(workloads, pods, pod logs, events, Services). Or set `runtime.bindings: true`:
the chart then ships the same rules as a ClusterRole bound nowhere, and a
component's page binds it in the component's namespace (below), so a new
namespace needs no chart change. Viewers of a project see it; maintainers
change it. The page also shows the component's Services, and for a
LoadBalancer the address an edge proxy sends its traffic to.

### `logs-kube` and `logs-loki`

Pod logs on a component's page, through the runtime plugin. `logs-kube` reads
live pods from the Kubernetes API and follows them (it needs the runtime
namespaces' read-only Role, which includes pod logs). `logs-loki` reads what
Loki kept after a pod is gone:

```yaml
logs-kube: {}
logs-loki:
  url: https://loki.example.com
  token: { env: LOKI_TOKEN } # optional
  tenant: team-a # optional X-Scope-OrgID
  lookbackHours: 168 # default a week
  labels: { namespace: namespace, pod: pod, container: container } # your collector's label names
```

Only a component's own pods can be read: a live pod must match one of its
workloads' selectors, and a kept one must be named after one of its
workloads. Logs are sent as plain text and never stored by stardust.

### `dns-cloudflare` and `dns-parallax`

DNS providers, for the features that write records (domains, instances).
Both can be enabled at once; each is a `dns` port by its name.

```yaml
dns-cloudflare:
  token: { env: CLOUDFLARE_DNS_TOKEN } # Zone:Read and DNS:Edit
  zones: [example.com] # optional: only these
dns-parallax:
  apiUrl: https://parallax.example.com
  token: { env: PARALLAX_TOKEN }
  views: [internal, external] # optional
```

A parallax write is published by applying its view at the revision the write
made (a write alone is a draft there); stardust then waits until that view
serves it.

### `cloud-audit` and `audit-cloudflare`

Cloud providers raise no alert when their configuration changes, so a stolen
token could change things unnoticed. `cloud-audit` reads every `auditLogs`
source (`audit-cloudflare` reads a Cloudflare account's log) every 30
minutes and keeps what its rules find on `/cloud-audit`:

- an automation token acting outside the action types it is for (high);
- any change to an area you never change through the API, `access_` by
  default (high);
- an account token you have not listed (medium);
- a failed attempt (medium), and a record without an action type (medium:
  the log's shape may have changed).

Each scan goes on from where the last one ended (five minutes back, a week at
most); a scan that fails or is cut short says so on the page.

```yaml
audit-cloudflare:
  accountId: 0123456789abcdef0123456789abcdef
  token: { env: CF_AUDIT_TOKEN } # Account: Audit Logs: Read
cloud-audit:
  automationTokens: # token id: the action type prefixes it may touch
    0123456789abcdef0123456789abcdef: [dns_]
  alwaysAlertPrefixes: [access_] # optional
```

### `cloud-vultr`

Provides the `compute` port on Vultr: the catalog (regions, plans, images,
SSH keys, private networks), instances, and the few changes stardust makes
(create, resize, clear user data, reverse DNS, console, delete).

A Vultr API key opens the whole account, and Vultr has no narrower keys, so
run the broker (`broker/vultr`) with the key and give stardust only a token
for the broker. The broker lets through the calls stardust makes and nothing
else, limits what a `PATCH` may change, and refuses a delete without a
ticket: signed with `deleteApprovalKey`, for that one instance, valid for
minutes, accepted once.

```yaml
cloud-vultr:
  account: vultr # optional: its name in the compute port
  broker:
    url: http://vultr-broker.stardust.svc:8080
    token: { env: VULTR_BROKER_TOKEN }
  deleteApprovalKey: { env: VULTR_DELETE_APPROVAL_KEY } # the broker's VULTR_DELETE_APPROVAL_TOKEN
  apiKey: { env: VULTR_API_KEY } # optional: without a broker, or as a fallback
```

With both a broker and `apiKey`, a call falls back to the key only when the
broker cannot be reached at all; any answer from the broker (a 403 above all)
is final. Each fallback bypasses the allowlist and is logged as a warning:
leave `apiKey` out to rule fallbacks out.

### `instances`

Cloud instances from `/instances`, on a `compute` account (`cloud-vultr`).
Creating runs in the background as a saga the worker resumes: the instance,
then (with `dns`) its public record when the hostname is in the zone and an
internal record for its private address, the reverse name of its address
(only for a public record, so that it resolves back), and finally its user
data is cleared, since cloud-init can carry bootstrap secrets. A create that
fails after the instance exists leaves it for you: deleting needs a person.

Other systems can take part through the `instanceHooks` port (a plugin that
provides it): before an instance is made a hook may add to its cloud-init
(such as a one-time enrolment token; parts are joined as cloud-init multipart,
never stored, and cleared once the instance runs) or refuse the create; it is
told when the instance runs, may refuse a delete, and is told after one.

Deleting takes two steps from someone who signed in recently: repeat the
hostname to get a ticket for that one instance (five minutes, used once),
then delete with it. Its DNS records go with it. Protected hosts are never
deleted.

```yaml
instances:
  account: vultr # optional
  sshKeys: [ops] # key names in the account
  cloudInit: | # optional; {{hostname}} is filled in
    #cloud-config
  dns: # optional
    provider: cloudflare
    zone: example.com
    internalSuffix: internal.example.com
  protected:
    prefixes: [db-]
    exact: [gateway.example.com]
```

### `costs`

Adds up what every billed source says it costs a month (a `cloud-vultr`
account prices its instances at their plans) and shows it on the home page to
administrators. A source that cannot answer is shown as unknown, never as
zero.

```yaml
costs: {}
```

### `databases`

PostgreSQL for your applications, through the deploy repository: administrators
create instances, adopt ones already running, and give an application its own
role and database on `/databases`. Stardust never connects to a database and
never shows a password. It generates passwords, seals them with the cipher
(`secrets-sops-age`), and commits manifests that an engine plugin (such as
`db-statefulset`) renders.

- **Create**: the instance's manifests and a sealed superuser password under
  `<root>/<name>/`.
- **Adopt**: records a running instance whose pod reads `POSTGRES_PASSWORD`
  from a Secret. Nothing of the instance changes.
- **Grant**: a Job that creates the role and a database it owns (and revokes
  `PUBLIC`'s connect), with the password sealed beside it, then
  `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`
  (optionally prefixed, e.g. `ORDERS_DATABASE_URL`) in the chosen env layer,
  so the components reading it roll out. Granting again sets a new password.
- **Revoke**: removes those env values and the grant's manifests. The role and
  its data stay in the database.
- **Backups**: with `backup` set, one CronJob per namespace that holds
  instances dumps each of them, encrypts the dump to the age key, uploads it,
  reads the stored size back and prunes old dumps. It is rendered again
  whenever the instances change.

```yaml
databases:
  root: deploy/databases # optional
  backup: # optional
    schedule: "15 3 * * *"
    storage:
      endpoint: https://s3.example.com
      bucket: backups
      credentials: db-backup-s3 # a Secret with access-key-id and secret-access-key, in each backed-up namespace
      prefix: pg
    recipient: age1... # the public key; keep the identity off the cluster
    retentionHours: 168
```

Point a GitOps Kustomization (with SOPS decryption) at `root`.

**Restore checks.** Every dump is stored with a fingerprint of its source,
taken just before it: every database's tables and their exact row counts,
hashed. "Check that it restores" commits a Job that restores the newest dump
into a throwaway server inside its own pod and succeeds only if it arrives at
the same fingerprint; stardust follows the Job, records the result and removes
it. Writes between the fingerprint and the dump can make an honest dump
differ, so check a quiet instance or retry. The check decrypts with the age
identity, so give it a namespace of its own (list it in the chart's
`databases.namespaces`) with the identity and the storage credentials:

```yaml
databases:
  restoreCheck:
    namespace: db-checks
    identity: { name: db-backup-age, key: identity }
  allowDelete: false # the default
```

**Deleting** is off unless `allowDelete: true`. Then an administrator who
signed in recently can delete an instance with no grants left, by repeating
its name. One stardust created also needs a passed restore check in the last
day; its manifests are removed, but its volume claim and data stay until a
person deletes them. An adopted instance is only forgotten.

### `db-statefulset`

Provides the `databases` port for PostgreSQL run as a plain StatefulSet (one
replica, a volume claim, a Service). It finds instances by image in the
namespaces it is given, reading the superuser password's Secret _name and
key_ from the pod's `POSTGRES_PASSWORD`, never its value, and the superuser
role from `POSTGRES_USER` (`postgres` when it is absent). An instance whose
`POSTGRES_USER` comes from a Secret or ConfigMap (or might, through
`envFrom`) cannot be adopted: set it as a plain value. It renders the
manifests that the `databases` feature commits: a new instance, a Job that
creates an application's role and database (safe to run again), and a backup
CronJob that dumps every instance, encrypts each dump with SOPS to an age key
(stored as `.sql.gz.sops.json`), uploads it to S3-compatible storage, reads
the stored size back and prunes old dumps. Every pod it renders passes Pod
Security Admission `restricted`, and each backup or restore-check step runs in
an official image pinned by digest (postgres, SOPS, the AWS CLI) with nothing
installed at run time.

```yaml
db-statefulset:
  namespace: stardust-databases # where new instances go
  namespaces: [apps] # optional: where else to find instances to adopt
  image: postgres # optional: tags are <version>-alpine
  versions: ["16", "17"] # optional
```

List every one of those namespaces in the chart's `databases.namespaces`, so
the server can read StatefulSets, claims and jobs there.

### `domains`

Administrators see every zone the DNS providers hold on `/domains`: the
registrar and expiry date from RDAP (soonest first, flagged under 30 days),
and each zone's records, which they can set and remove through the zone's
provider (audited as `domains.record.set` and `domains.record.delete`). Zones
are read every six hours and RDAP data daily, or at once with "Refresh".

```yaml
domains:
  providers: [cloudflare, parallax] # optional: the dns plugins to read; all by default
  rdap: true # optional
```

### `nodes`

Hosts running the node agent. An administrator issues a token for a host on
`/nodes` (shown once; issuing again revokes the earlier one), and the agent
keeps a WebSocket open to
`<server>/api/v1/plugins/nodes/infra/node-socket` with
`Authorization: Bearer stnode_…`: set the agent's `url` to
`<server>/api/v1/plugins/nodes`. A host is _online_ while it beats (every five
seconds), _degraded_ for the 90 seconds a reconnect may take, then _missing_.
Revoking a token disconnects the host at its next beat.

```yaml
nodes: {}
```

Only each host's latest metrics are kept, for the list. Send time series to
a metrics system instead. The ingress in front of stardust must pass
WebSocket upgrades; most controllers do so without extra configuration.

### `store-s3`

Object storage on S3, R2 or MinIO (path-style requests, Signature V4). With
it, the worker keeps each finished build's log — credentials it recognises
(GitHub tokens, URL passwords, `Authorization` headers, AWS key ids) masked —
at `build-logs/<project>/<run>/<job>.log`, and the run page shows that copy
once the cluster has cleaned the build up.

```yaml
store-s3:
  endpoint: https://<account>.r2.cloudflarestorage.com
  bucket: stardust
  region: auto # R2; for S3 the bucket's region
  accessKeyId: { env: S3_ACCESS_KEY_ID }
  secretAccessKey: { env: S3_SECRET_ACCESS_KEY }
  prefix: stardust/ # optional
```

Give the credentials to both the server (reads) and the worker (writes).
Expire old logs with a bucket lifecycle rule; stardust does not delete them.

## Environment and secrets

A project's runtime environment lives in env layers in the deploy repository,
in the layout stardust has always read:

```
deploy/env/<project>/_shared/runtime.yaml               plain values, every component
deploy/env/<project>/_shared/runtime.secret.enc.yaml    SOPS-encrypted values, every component
deploy/env/<project>/<component>/runtime.*              one component's own
deploy/env/_global/runtime.*                            every project (read, not edited here)
```

`deploy/env` is the default; `gitops-git`'s `envRoot` moves all of it,
`_global` included. When one deploy repository serves several installations,
give each its own root (for example `clusters/<name>/env`): every
installation then reads only its own global layer, and its age identity only
ever needs to open the files under its root.

From the layers stardust renders, in each component's `deployDir`,
`env.configmap.yaml` (ConfigMap `<component>-env`) and `env.secret.enc.yaml`
(Secret `<component>-env-secret`, encrypted), and lists both in the
directory's `kustomization.yaml`. Use them from the workload with `envFrom`:
starter manifests already do (both references `optional`, so a component
starts before any value is set), and an existing component can be wired from
Cluster access on its page (`PUT …/components/<name>/access` with
`"envVars": true`). Until a workload reads them, a change commits but reaches
no process.

A ConfigMap `<component>-env` or Secret `<component>-env-secret` made by hand
in another file of the directory (before stardust managed the env) would
collide with the rendered ones, so the next change to a layer reaching that
component adopts it, in the same commit: its values move into the component's
own layer (a value already there wins) and its document leaves its file; a
file left empty is removed and unlisted. A SOPS file of several documents is
decrypted whole and what is left is encrypted again. The env page names what
would be adopted and can do it alone ("Move them now", or `"adopt": true` with
no other change). A Secret by that name that is not `Opaque` is refused.

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
- On the env page a value can be given as a file instead of typed (a key, a
  JSON credential, a config file): UTF-8 text, taken as it is, newlines
  included.
- Each change is in the audit log as `env.change`, with the names it touched.

To turn it on, give the server what it writes with:

1. `plugins.gitops-git` and its credentials (the server reads them like the
   worker: with the chart's `extraEnvFrom`, both get the same environment).
2. `plugins.secrets-sops-age` with `ageKeyFile: /run/secrets/age/keys.txt`
   and the recipients.
3. The age identity in a Secret, named in the chart's
   `envEditing.ageKeySecret` (key `keys.txt` by default). Only the server
   mounts it.

A **plain value whose name looks like a secret's** (`*_TOKEN`, `*_PASSWORD`,
`DATABASE_URL`, `API_KEY` and the like; client ids, key ids and `PUBLIC_*`
names are not) is refused, because plain values are committed to Git in
clear: save it as a secret, or list it in `plainOnPurpose` (the dashboard's
"The value is public" box) when it really is public.

**Secrets as files.** A program that reads a key or a config file from disk
can have env secrets mounted instead: on the component's page, pick a secret
and a path in the container. stardust adds one volume, `stardust-files`, with
just those keys from the component's env Secret, and mounts each read-only at
its path (`subPath`, so the rest of the directory is untouched), as one commit
to the workload's manifest (`PUT /api/v1/projects/<id>/components/<name>/files`
with `{"mounts": [{"key": "APNS_KEY", "path": "/etc/app/key.p8"}]}`, for
maintainers). A key the component's env Secret does not have is refused. When
a secret changes, the env change rolls the workload out, which mounts the new
file.

With the runtime plugin, a component's page shows whether its env has
**landed**: committed but not applied yet, applied but still rolling out, or
running with it — from the env ConfigMap's revision and the workload's pod
template. Secrets are never read for this.


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

### Deleting a project

An administrator can delete a project from its settings page, or with
`DELETE /api/v1/projects/<id>` and the body `{"confirm": "<id>"}`. Its runs,
jobs and memberships are deleted; the audit log keeps its history. With
`"withdraw": true` its components' manifests are removed from the deploy
repository first, in one commit, together with the entries that list their
directories in the kustomizations above them, so the GitOps controller prunes
what they deployed. Nested directories inside a deploy directory are not
removed.

### Components

| Pipeline | Builds                                  | Fields                                                                           |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `C`      | the repository's own Dockerfile         | `context` (default the root), `dockerfile` (default `Dockerfile` in the context) |
| `N`      | a Node application without a Dockerfile | `context`, `port` (default 3000), `buildEnv`                                     |

Pipeline `W` releases a Cloudflare Worker instead of building an image (fields
`context` and `buildEnv`); see below.

Pipeline `M` builds nothing: it copies a published image, pinned by digest
(field `image`, e.g. `docker.io/org/app:2.7@sha256:…`), into your registry
with a Job that runs none of the project's code, and checks the copy has the
same digest.

#### Someone else's code

A project whose metadata says `trust: external` is an open-source project
deployed as it is. Its builds get no clone token and no project secret, it is
only mirrored (pipeline `M`) unless you list it in `jobs.upstreamBuilds`
(a build still pushes, so dropping the tokens alone is not a boundary), and
with `pin: <commit>` only that commit runs; a run asks for the pin when
nothing else is asked.

```yaml
jobs:
  upstreamBuilds: [station] # external projects whose own code may be built
```

With `upstream-images: {}`, stardust checks daily whether the image each
mirrored component is pinned to has a newer release on Docker Hub (the newest
stable version, else the newest version, else the newest tag), and lists them
on `/upstream-images`. It changes nothing: move the pin by editing the
component. Images elsewhere are listed as not checked.

#### Pipeline W: `target-cf-workers`

Pipeline `W`: a component released as a Cloudflare Worker instead of an image.
A release Job in the builds namespace clones the commit, installs with the
lockfile's package manager and runs `build` (with no credentials of any
kind), then a Wrangler that stardust pins applies the D1 migrations of every
`d1_databases` binding, uploads secrets with `wrangler secret bulk`, and
deploys. The job records the Worker's version id. Pull requests are never
released.

```yaml
target-cf-workers:
  namespace: stardust-builds # where release Jobs run
  tokenSecret: cloudflare-deploy # keys token and account-id
  cloneSecret: github-clone # optional, for private repositories
  wranglerVersion: "4.156.0" # optional
```

The Worker's configuration is yours, not the repository's: keep, in that
namespace, a ConfigMap `wrangler-<project>-<component>` with key
`wrangler.jsonc`, and optionally a Secret of the same name with key
`secrets.json`. The release ignores the repository's own `.env` files and
Wrangler configs. Paths in `wrangler.jsonc` (`main`, `migrations_dir`) are
relative to the component's `context`.

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

Components can also be changed one at a time
(`PUT`/`DELETE /api/v1/projects/<id>/components/<name>`). For a component
whose deploy directory is empty, the component's page (or
`POST …/components/<name>/scaffold` with `{"namespace": …, "port": …}`)
writes starter manifests: a Deployment using the component's image at the tag
`pending`, a Service for the port, and a kustomization. It never overwrites a
directory that has files. In the same commit it lists the directory in the
nearest `kustomization.yaml` above it (by its path from there), so the GitOps
controller applies it; the answer's `listedIn` names that file, or is null when
none above has a `resources` list. With `"createNamespace": true` it also
declares the namespace, enforcing the restricted Pod Security standard; it is
then removed with the component, so leave it off for a shared namespace.
With `"expose": true` the Service is a LoadBalancer, so it gets an address
outside the cluster; routing a public host to it, and its DNS record, are set
at the edge proxy.

A component's namespace can also get, as files next to its manifests (listed
in its kustomization, so withdrawing removes them) — at scaffolding
(`"registryPull": true`, `"podView": true`) or later on its page
(`PUT …/components/<name>/access` with the same fields, administrators):

- `registry-pull.secret.enc.yaml`: the builder's `pull` login as a
  `kubernetes.io/dockerconfigjson` Secret `<component>-registry-pull`, sealed
  with SOPS, which its workloads name in `imagePullSecrets` (pull Secrets
  made by hand are kept and listed). After the login changes,
  `POST /api/v1/registry/pull/reseal` reseals every one in one commit.
- `stardust-runtime.rolebinding.yaml`: a RoleBinding of the chart's runtime
  ClusterRole to the server, so the page can show the namespace (needs
  `runtime.bindings`).

The same call's `"envVars"` adds or removes the `envFrom` references to the
component's env ConfigMap and Secret in each container, keeping any others.

All are audited (`project.component.access`, `registry.pull.reseal`).

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

A run is refused before anything is built (409, naming the components) when
a component's deploy directory has no manifest that uses its image: the build
could not be delivered.

This is the only way a run starts. A merge, even to a public repository you do
not control, reaches your cluster only when someone asks for a specific commit,
and pinning a tag says exactly which one.

A definition may still carry an `on` block and `if.paths` filters from an
older installation; they are accepted and have no effect.

A job that has not finished can be **cancelled** from the run's page or with
`POST /api/v1/projects/<id>/runs/<runId>/jobs/<job>/cancel` (maintainers). A
running build is stopped: its worker loses the job at the next lease renewal
and deletes the build Job. `jobs.maxRunning` in `stardust.yaml` caps how many
jobs run at once across all workers (default 0, no limit).

### Rolling back

Each component's page lists its **deliveries**, newest first
(`GET /api/v1/projects/<id>/components/<name>/deliveries`): the commit built,
the image it pushed, the deploy commit. A maintainer can point the component
back at an earlier one — the previous delivery, or a chosen one
(`POST /api/v1/projects/<id>/components/<name>/rollback` with an optional
`{"job": "<job id>"}`). It is one commit to the deploy repository, like a
delivery, and Flux rolls it out. The audit log records it as
`project.rollback`. Delivering again from the project's page moves it forward.
