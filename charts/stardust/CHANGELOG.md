# stardust

## 0.5.0

### Minor Changes

- [`3c1497b`](https://github.com/henryj-dev/stardust/commit/3c1497b5e8669e793fe3e844e1d674c7b504cf61) Thanks [@mack-erel](https://github.com/mack-erel)! - The deploy repository can be written as a GitHub App (`plugins.gitops-git.githubApp`: `appId`, `privateKey`) instead of with a long-lived token. stardust asks for installation tokens narrowed to the deploy repository and to `contents: write`, renews them before they expire, and gives git the credential only for commands that reach the host.

## 0.4.2

### Patch Changes

- [`97810a1`](https://github.com/henryj-dev/stardust/commit/97810a13c4fe06676e657f8a0c9791f1d1b4eb06) Thanks [@mack-erel](https://github.com/mack-erel)! - The dashboard honours `ORIGIN`. 0.4.1 set it from `config.server.publicUrl`, but SvelteKit 3 reads the origin only at build time, so it had no effect and forms posted over plain http were still refused as cross-site. The image now starts through its own entry point, which gives the adapter that origin on every request.

## 0.4.1

### Patch Changes

- [`4f1ca8f`](https://github.com/henryj-dev/stardust/commit/4f1ca8fb73bf354849a7d2047c971c5fb130082f) Thanks [@mack-erel](https://github.com/mack-erel)! - An empty plugin section (`source-github:` with nothing after it, or `{}` in Helm values, which Helm renders as null) enables the plugin with its defaults instead of stopping the server with "must be a mapping". The chart gives the dashboard `ORIGIN` from `config.server.publicUrl`: without it the dashboard assumed https and refused sign-in and every form posted over plain http as cross-site.

## 0.4.0

### Minor Changes

- [`e31a480`](https://github.com/henryj-dev/stardust/commit/e31a48080f6a38d4bddd5fca513d236cabca3565) Thanks [@mack-erel](https://github.com/mack-erel)! - Manual runs: `POST /api/v1/projects/:id/runs` (and "Pull and deliver" on a project's page) builds and delivers the default branch's head, or a chosen branch, tag or commit. A commit given by hash must be in the default branch's history. The run records who asked. A project with `webhookKind: "off"` ignores webhooks and is delivered this way only. The source token, the webhook secret and the builder's clone secret are now optional, so a public repository can be delivered with no credentials for its host.

## 0.3.1

### Patch Changes

- [`2efa83f`](https://github.com/henryj-dev/stardust/commit/2efa83fe6134714dcbec570858fc93bdd0b22029) Thanks [@mack-erel](https://github.com/mack-erel)! - Pipeline N images run as user `1000:1000` instead of `node`: with `runAsNonRoot`, Kubernetes refused to start a container whose image user is a name it cannot check.

## 0.3.0

### Minor Changes

- [`8b2cde6`](https://github.com/henryj-dev/stardust/commit/8b2cde6e2c25b0378d007ca2c50bfaabb79378a9) Thanks [@mack-erel](https://github.com/mack-erel)! - Pipeline N builds: a Node application without a Dockerfile of its own is built with its lockfile's package manager and run from `build/` (or its own `server.js`). Components take `port` and `buildEnv` for it. The Dockerfile is a constant; the Node image, port and build environment reach it only as build arguments.

## 0.2.0

### Minor Changes

- [`781c746`](https://github.com/henryj-dev/stardust/commit/781c746daebdfed128397995553de05c5f5295ca) Thanks [@mack-erel](https://github.com/mack-erel)! - Administrators change users with `PATCH /api/v1/users/:username`: link or unlink an OpenID identity, grant or remove administration, disable (which ends the user's sessions and API tokens). A change that would leave no enabled administrator is refused.

- [`f1ab747`](https://github.com/henryj-dev/stardust/commit/f1ab747975588be17bb40fe253f0c9bcd029011e) Thanks [@mack-erel](https://github.com/mack-erel)! - `POST /api/v1/projects/:id/plan` reports what a webhook delivery would do without doing it: the same policy, trigger and changed-path decision the webhook makes, and whether each job would run or be skipped. For running a new installation in the shadow of an existing one, and for checking a pipeline definition. A candidate `pipelineDef` in the request is judged instead of the stored one.

- [`2d79583`](https://github.com/henryj-dev/stardust/commit/2d79583bedf76a70668a85fe8cae327916008ec0) Thanks [@mack-erel](https://github.com/mack-erel)! - Read projects and users through the API: `GET /api/v1/projects` (all for administrators, memberships for others), `GET /api/v1/projects/:id`, and `GET /api/v1/users` (administrators; roles and linked identities, never password hashes).

## 0.1.1

### Patch Changes

- [`a95df5c`](https://github.com/henryj-dev/stardust/commit/a95df5c928b8ea58e2b886f2c39e938535844c21) Thanks [@mack-erel](https://github.com/mack-erel)! - The chart installs through Flux from OCI: the `helm.sh/chart` label no longer carries the `+<digest>` build metadata that Flux appends to the chart version, which the API server rejects as a label value.

## 0.1.0

### Minor Changes

- [`ef2dcee`](https://github.com/henryj-dev/stardust/commit/ef2dcee8b5891dba81cb285326f3d18f6cb9d543) Thanks [@mack-erel](https://github.com/mack-erel)! - API tokens for automation (`/api/v1/tokens`), and a `reset-password` recovery command run inside the server container.

- [`638c7dd`](https://github.com/henryj-dev/stardust/commit/638c7ddfa06f4d17b65318ed63f75ecb4bffffd7) Thanks [@mack-erel](https://github.com/mack-erel)! - A pipeline definition without an `on` block now runs only for pushes to the repository's default branch, not for every branch.

- [`de867c2`](https://github.com/henryj-dev/stardust/commit/de867c2f03ab09e2de72a8493e365b16c49b4a59) Thanks [@mack-erel](https://github.com/mack-erel)! - Single sign-on through any OpenID Connect provider (`plugins.identity-oidc`), with optional group-based access and administration.

- [`8116a30`](https://github.com/henryj-dev/stardust/commit/8116a30374ecf7081da57eb3edabe6da51301080) Thanks [@mack-erel](https://github.com/mack-erel)! - Security fixes from the pre-publication review:
  - Pull requests are built but no longer deployed.
  - Workspace projects refuse pull requests from forks.
  - A webhook delivery must name the project's repository, and a re-sent delivery starts nothing.
  - Parallel sign-in guesses no longer bypass the lockout.
  - Passwords are capped at 1024 characters and API bodies at 64 KiB.
  - A password reset also revokes the user's API tokens.
  - The sign-in redirect accepts only paths on the same site.

- [`e3d0df3`](https://github.com/henryj-dev/stardust/commit/e3d0df3f89b6afc1f8dbacf4f87171cb3eb28d21) Thanks [@mack-erel](https://github.com/mack-erel)! - Users sign in with a username and password instead of a shared admin token. `server.adminToken` is replaced by `server.bootstrapAdmin`, which creates the first administrator once, while there are no users. Projects grant `maintainer` or `viewer` roles; people who are not members get 404 for a project.

- [`51fb859`](https://github.com/henryj-dev/stardust/commit/51fb859d3babf7d69dbee144b993f0ba9dd6c7ae) Thanks [@mack-erel](https://github.com/mack-erel)! - The worker connects to PostgreSQL, applies the database migrations on start and runs the job queue. It builds images with rootless BuildKit as Kubernetes Jobs and commits digest-pinned image updates to the deploy repository, which the GitOps controller applies.

## 0.0.1

### Patch Changes

- [`5768af6`](https://github.com/henryj-dev/stardust/commit/5768af6f5eb3dbdcfd4b4e683499ed8ccd4156c0) Thanks [@mack-erel](https://github.com/mack-erel)! - First release of the skeleton: server, worker and web images and the Helm chart. Nothing is usable yet; this release exists to exercise the release pipeline end to end.
