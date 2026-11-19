# stardust

## 0.25.3

### Patch Changes

- [#122](https://github.com/henryj-dev/stardust/pull/122) [`2be3343`](https://github.com/henryj-dev/stardust/commit/2be33437d2e46aac0df4c2e780a22906262a01ac) Thanks [@mack-erel](https://github.com/mack-erel)! - A followed log opens at once: a pod (or build) that had printed nothing yet left the browser on "connecting", because SvelteKit's Node adapter sends the headers only with the first byte of the body. The relay now leads the body with an empty chunk, which sends them.

## 0.25.2

### Patch Changes

- [#120](https://github.com/henryj-dev/stardust/pull/120) [`e2c798d`](https://github.com/henryj-dev/stardust/commit/e2c798d073fc6a0fb0e910e4793f249d9dc1988b) Thanks [@mack-erel](https://github.com/mack-erel)! - Pod logs work again: the runtime plugin now says it uses the log sources, so logs-kube and logs-loki are built when enabled (they were never built, and the pod page said no live log source was enabled). A live log is followed again: the page added `?follow=true` after a URL that already had a query.

## 0.25.1

### Patch Changes

- [#118](https://github.com/henryj-dev/stardust/pull/118) [`adcd4fc`](https://github.com/henryj-dev/stardust/commit/adcd4fcd3c7c54aada9510e6ea092757650b4d00) Thanks [@mack-erel](https://github.com/mack-erel)! - The env page edits a value in place: a plain value has an Edit form holding its current value, and a secret that has been shown can be edited where it is instead of retyped.

## 0.25.0

### Minor Changes

- [#116](https://github.com/henryj-dev/stardust/pull/116) [`da1ce99`](https://github.com/henryj-dev/stardust/commit/da1ce9950a71db8c3f41bf7a015d08a1167aa5d8) Thanks [@mack-erel](https://github.com/mack-erel)! - The env page, as Coolify's: maintainers can show a secret's value (audited by name, never cached), values may span several lines (typed, not only as files), and a value may use `${NAME}` and `{{project.NAME}}`, resolved when the env is rendered — in multi-line secrets too — unless the value is marked Literal. A reference to nothing, a cycle, or a plain value that uses a secret is refused.

## 0.24.0

### Minor Changes

- [#114](https://github.com/henryj-dev/stardust/pull/114) [`ee0aafe`](https://github.com/henryj-dev/stardust/commit/ee0aafe31de71885c54582a441941fb025f747a1) Thanks [@mack-erel](https://github.com/mack-erel)! - Components get persistent storage on their page: volumes with a mount path, a size and a StorageClass, written as a claim per volume next to the manifests and mounted in one commit, with fsGroup for non-root images and one pod at a time. Unmounting keeps the data; deleting it needs a confirmation. A claim already mounted under stardust's names (added by hand) is picked up as it is, and another claim the workload mounts can be taken over without being made again.

## 0.23.6

### Patch Changes

- [#112](https://github.com/henryj-dev/stardust/pull/112) [`c463777`](https://github.com/henryj-dev/stardust/commit/c4637770eb50008c1a7e1cba9524bf4638961e36) Thanks [@mack-erel](https://github.com/mack-erel)! - The build state cache falls back to the plain archive again: rclone's copyto exits 0 for an object that does not exist, so a missing `.tar.gz` counted as fetched and the `.tar` an earlier release saved was never restored. A fetch now counts only when the file is there.

## 0.23.5

### Patch Changes

- [#110](https://github.com/henryj-dev/stardust/pull/110) [`a98744b`](https://github.com/henryj-dev/stardust/commit/a98744b6352f9b66419eb934ea9272e2ee2155dc) Thanks [@mack-erel](https://github.com/mack-erel)! - A job whose worker stopped (an upgrade or an evicted pod) is queued again and the next worker takes over the build or release Job already running, instead of the job being recorded as `unknown` while the Job went on to succeed. Only an operator's cancellation deletes the Job; after three stopped workers the job is `unknown`, with the reason on the run's page.

## 0.23.4

### Patch Changes

- [#108](https://github.com/henryj-dev/stardust/pull/108) [`c7899c4`](https://github.com/henryj-dev/stardust/commit/c7899c4f51b550cc37204042f9dc02b31878c007) Thanks [@mack-erel](https://github.com/mack-erel)! - The build state cache prunes cache records unused for `stateCache.keepDuration` (default `168h`) before packing, not only when the state outgrows `maxBytes`: a cache mount a Dockerfile stopped using was otherwise carried, gigabytes at a time, on every build.

## 0.23.3

### Patch Changes

- [#106](https://github.com/henryj-dev/stardust/pull/106) [`c4213d7`](https://github.com/henryj-dev/stardust/commit/c4213d7060a975d77083792141a5b980f0961241) Thanks [@mack-erel](https://github.com/mack-erel)! - The build state cache is compressed with pigz on every core and fetched over several streams, and a rebuild that reused the state no longer re-uploads it because an export wrote a runc log and a few small blobs. On pico's Rust image (a 3.15 GB state) a rebuild of the same commit spent about three of its four minutes moving the state; pigz halves it in 22 seconds.

## 0.23.2

### Patch Changes

- [#103](https://github.com/henryj-dev/stardust/pull/103) [`1cda9c6`](https://github.com/henryj-dev/stardust/commit/1cda9c68321cf85c1248b2e02fddbc16f5424526) Thanks [@mack-erel](https://github.com/mack-erel)! - The build state cache is a plain tar and is saved only when the build wrote something new into it: on pico's Rust image a rebuild spent three of its four minutes compressing, decompressing and re-uploading an unchanged 1.5 GB state.

## 0.23.1

### Patch Changes

- [#102](https://github.com/henryj-dev/stardust/pull/102) [`bc1de57`](https://github.com/henryj-dev/stardust/commit/bc1de574e85c221f5a7bfce027dbd86997291f18) Thanks [@mack-erel](https://github.com/mack-erel)! - Live build logs, pod logs and the project event stream reach the browser as they are written when an nginx sits in front: their responses say `X-Accel-Buffering: no`, so the proxy no longer holds them back until its buffer fills.

## 0.23.0

### Minor Changes

- [#100](https://github.com/henryj-dev/stardust/pull/100) [`cda69cd`](https://github.com/henryj-dev/stardust/commit/cda69cd74d0bce65a1a444c06abe7a4282573faa) Thanks [@mack-erel](https://github.com/mack-erel)! - builder-buildkit `stateCache` keeps the whole BuildKit state of chosen components (cache mounts included) in an S3-compatible bucket between builds, so a Rust `target` or a package cache carries over without changing the Dockerfile. Only the restore and save containers hold the storage credential; the state is packed inside BuildKit's user namespace; any failure means a cold build, never a failed one.

## 0.22.0

### Minor Changes

- [#98](https://github.com/henryj-dev/stardust/pull/98) [`dce5e80`](https://github.com/henryj-dev/stardust/commit/dce5e8032b916a4d38f17ac001085e767e56b86d) Thanks [@mack-erel](https://github.com/mack-erel)! - Builds reuse layers between runs: builder-buildkit imports and exports a registry cache at `<repository>:buildcache` per component (`cache: registry`, the default; `off` to build from scratch). External projects' builds never use one, and a failed export does not fail the build.

## 0.21.3

### Patch Changes

- [#96](https://github.com/henryj-dev/stardust/pull/96) [`f8cfc44`](https://github.com/henryj-dev/stardust/commit/f8cfc44a051a35e0a185718f825ddf32faa0a791) Thanks [@mack-erel](https://github.com/mack-erel)! - Pages that ask you to confirm it is you offer "confirm through single sign-on" only when the server has single sign-on set up; started anyway, it sends you to the sign-in page with a message instead of a 500.

## 0.21.2

### Patch Changes

- [#94](https://github.com/henryj-dev/stardust/pull/94) [`5685396`](https://github.com/henryj-dev/stardust/commit/5685396057368821146f532f21b30bb1ae3b0c94) Thanks [@mack-erel](https://github.com/mack-erel)! - A Worker release's log shows on its run page: the log reader reads the pod's main container when it has no build container (a release's is `deploy`), and a running or failed init step before it starts. Before, the page asked again forever with "the build has not started printing yet".

## 0.21.1

### Patch Changes

- [#91](https://github.com/henryj-dev/stardust/pull/91) [`b090a19`](https://github.com/henryj-dev/stardust/commit/b090a19a04235bcf994f38698d0266c01079f4eb) Thanks [@mack-erel](https://github.com/mack-erel)! - Adopting hand-made env from a SOPS file stardust cannot decrypt (one encrypted only to the cluster's and the operator's keys) is refused with what to do, instead of failing with a server error.

## 0.21.0

### Minor Changes

- [#89](https://github.com/henryj-dev/stardust/pull/89) [`46e82a1`](https://github.com/henryj-dev/stardust/commit/46e82a1cd2047e2b65a976fd8d2883832bbcc147) Thanks [@mack-erel](https://github.com/mack-erel)! - The env editor adopts a component's hand-made `<component>-env` ConfigMap or `<component>-env-secret` Secret with the next change (or on its own with "Move them now"): their values move into the component's layer and their documents leave their files in the same commit, instead of a second object by the same name breaking the kustomization. Kustomization entries with a trailing comment are now read, added after and removed correctly.

## 0.20.1

### Patch Changes

- [#87](https://github.com/henryj-dev/stardust/pull/87) [`6b607d9`](https://github.com/henryj-dev/stardust/commit/6b607d9255ca03e16c9181b8ffbea8a2373b05ec) Thanks [@mack-erel](https://github.com/mack-erel)! - A mirror (pipeline M) is reported as delivered: its Job's container is named like a build's, so the executor finds the digest line and the log reader the log. Before, every mirror failed with "printed no image digest" after copying the image.

## 0.20.0

### Minor Changes

- [#85](https://github.com/henryj-dev/stardust/pull/85) [`e51277a`](https://github.com/henryj-dev/stardust/commit/e51277ad761ce655e8b486eebe5c26030f1a1ce8) Thanks [@mack-erel](https://github.com/mack-erel)! - The project form offers pipeline M: give a published image pinned by digest, and each delivery copies exactly that image into the registry without building anything.

## 0.19.0

### Minor Changes

- [#83](https://github.com/henryj-dev/stardust/pull/83) [`57d70a7`](https://github.com/henryj-dev/stardust/commit/57d70a7b68f411364f8ef7821f2d5ff31c811202) Thanks [@mack-erel](https://github.com/mack-erel)! - Starter manifests now read the env page's values as environment variables (an optional `envFrom` for the env ConfigMap and Secret), so values set on the env page reach the process. An existing component can be wired the same way from Cluster access on its page.

## 0.18.0

### Minor Changes

- [#81](https://github.com/henryj-dev/stardust/pull/81) [`6d39a8f`](https://github.com/henryj-dev/stardust/commit/6d39a8f739d8e999f42fd0b4674a6fe5c8d3c65d) Thanks [@mack-erel](https://github.com/mack-erel)! - The dashboard has a look of its own instead of the browser's defaults: a top bar that marks the current section, pages with a set width, tables, forms and buttons styled alike, messages in colored boxes, and a dark theme that follows the system. A project's pages (runs, environment, audit log, settings) are tabs under its name, its components are chips, pulling a ref is one row, and the project form puts short fields side by side.

- [#81](https://github.com/henryj-dev/stardust/pull/81) [`6d39a8f`](https://github.com/henryj-dev/stardust/commit/6d39a8f739d8e999f42fd0b4674a6fe5c8d3c65d) Thanks [@mack-erel](https://github.com/mack-erel)! - A component's deploy directory can be filled in for you: set `gitops-git.deployDirTemplate` (for example `deploy/apps/{project}/{component}`), and the project form suggests the directory as the project id and component name are typed, while a directory typed by hand is kept. A component created through the API without a `deployDir` gets the template's (`GET /api/v1/deploy/defaults` tells administrators the template).

## 0.17.0

### Minor Changes

- [#79](https://github.com/henryj-dev/stardust/pull/79) [`fcfd673`](https://github.com/henryj-dev/stardust/commit/fcfd673051af1473fb3e4cf6d384b9b714607c0b) Thanks [@mack-erel](https://github.com/mack-erel)! - A component's namespace can get what it needs from the cluster from the dashboard, instead of by hand in the deploy repository. With a read-only registry login in `plugins.builder-buildkit.pull`, stardust seals a pull Secret into the component's directory and names it in the workloads' `imagePullSecrets`; when the login changes, one button reseals them all in one commit. With the chart's new `runtime.bindings: true`, the chart ships a read-only ClusterRole bound nowhere, and the component binds it in its own namespace, so the dashboard shows its pods without a chart change. Both can be chosen when scaffolding or turned on and off later on the component's page (`GET`/`PUT …/components/<name>/access`, `POST /api/v1/registry/pull/reseal`). Scaffolding can also make the Service a LoadBalancer (`expose`), and the component's page shows its Services and the address an edge proxy sends traffic to. The runtime Role now also reads Services.

## 0.16.0

### Minor Changes

- [#77](https://github.com/henryj-dev/stardust/pull/77) [`23249d1`](https://github.com/henryj-dev/stardust/commit/23249d167d455f15839488697711661c4f0d0fc6) Thanks [@mack-erel](https://github.com/mack-erel)! - Creating a component's starter manifests now lists its directory in the nearest `kustomization.yaml` above it, in the same commit, so the GitOps controller applies it; before, the new files sat in the deploy repository and nothing ran until someone listed them by hand. The page says where it was listed, or that no kustomization above could list it. A new "Also create the namespace" option adds a Namespace with the restricted Pod Security standard (removed with the component, so leave it off for a shared namespace). The API takes `createNamespace` and answers `listedIn`.

## 0.15.0

### Minor Changes

- [#74](https://github.com/henryj-dev/stardust/pull/74) [`2253304`](https://github.com/henryj-dev/stardust/commit/2253304d3134736d01539a84bec86d3aa2a048e6) Thanks [@mack-erel](https://github.com/mack-erel)! - A value on the env page can now come from a file: a key, a JSON credential or a config file, taken exactly as it is, newlines included. Only UTF-8 text up to 32 KiB is accepted, and not a typed value and a file together. Before this, secrets were typed into a one-line field, so a multi-line key could not be stored at all.

- [#76](https://github.com/henryj-dev/stardust/pull/76) [`df3a2f4`](https://github.com/henryj-dev/stardust/commit/df3a2f49ffc84757e3648f9132c10f5c13b29702) Thanks [@mack-erel](https://github.com/mack-erel)! - A component can read env secrets as files. On its page, choose a secret and a path in the container (`/etc/app/key.pem`), and stardust commits a read-only mount of that key to the component's Deployment, each file on its own path so the rest of the directory stays as it is. Only secrets the component's env Secret has can be mounted; clearing a path removes the file. The API is `GET` and `PUT /api/v1/projects/<id>/components/<name>/files`, for the project's maintainers; the audit log names keys and paths, never values.

- [#73](https://github.com/henryj-dev/stardust/pull/73) [`a23f320`](https://github.com/henryj-dev/stardust/commit/a23f320eb4049eaa8e6b0f03f743d72d06c21400) Thanks [@mack-erel](https://github.com/mack-erel)! - The project form has a "Check access" button that says whether stardust can read the repository: public, through the GitHub App, with the configured token, or not at all. A project's settings show it when they open. It warns when stardust cannot read a repository, which runs would refuse, and when the GitHub App is installed on all of the owner's repositories, so a leaked key would read every one. The check is also `GET /api/v1/source/access?repo=owner/name`, for administrators, and `sourceAccess` in the SDK.

## 0.14.1

### Patch Changes

- [#71](https://github.com/henryj-dev/stardust/pull/71) [`d60c2b1`](https://github.com/henryj-dev/stardust/commit/d60c2b1c9cbc250d2e3f859c43bdf318e50f5958) Thanks [@mack-erel](https://github.com/mack-erel)! - Releases now publish the Vultr broker image, `ghcr.io/henryj-dev/stardust-vultr-broker`, for amd64 and arm64, signed and attested like the other images and listed with its digest in the release notes. Its tests run before it is pushed. The broker stays out of the Helm chart; `broker/vultr/README.md` explains how to pin it by digest and verify its signature.

## 0.14.0

### Minor Changes

- [#68](https://github.com/henryj-dev/stardust/pull/68) [`3b31b04`](https://github.com/henryj-dev/stardust/commit/3b31b04d4da16a4afeb0b48da185135aa08aa2a2) Thanks [@mack-erel](https://github.com/mack-erel)! - The Account page now lists your API tokens with when each was made, last used and expires, makes a new one that lasts 1, 7, 30 or 90 days or never, and revokes them, so you no longer have to script a sign-in to get a token. A new token is shown once, with a copy button. Making a token now needs a sign-in from the last few minutes, as deleting a project does, because a token itself passes that check.

### Patch Changes

- [#69](https://github.com/henryj-dev/stardust/pull/69) [`c0494b4`](https://github.com/henryj-dev/stardust/commit/c0494b46f48d3cf3a26e91188f1cc20b53a5c41e) Thanks [@mack-erel](https://github.com/mack-erel)! - Restore checks now finish: the worker, which follows their Jobs, gets its own account bound to the read-only `databases.namespaces` Roles (also when builds are off). Before, it could not read the Jobs and the checks stayed pending; a check it cannot follow is now logged.

## 0.13.4

### Patch Changes

- [#66](https://github.com/henryj-dev/stardust/pull/66) [`cecf0c9`](https://github.com/henryj-dev/stardust/commit/cecf0c9f2c0f1f99c0336cc68fa5872cee2f06dd) Thanks [@mack-erel](https://github.com/mack-erel)! - The `databases` plugin no longer stops the worker from starting where only the server holds the age key: the cipher is needed only to create an instance or grant a role, and those answer 503 in a process without it.

## 0.13.3

### Patch Changes

- [#64](https://github.com/henryj-dev/stardust/pull/64) [`b4bb357`](https://github.com/henryj-dev/stardust/commit/b4bb35733150ea0fca2295ab40befc0516f23df7) Thanks [@mack-erel](https://github.com/mack-erel)! - Databases: backups and grants now sign in as the instance's own superuser role. `db-statefulset` reads it from the pod's `POSTGRES_USER` (`postgres` when that is absent), so instances made by the official image with another `POSTGRES_USER` no longer fail with "role postgres does not exist". Adopted instances remember the role (existing ones keep `postgres`). An instance whose `POSTGRES_USER` comes from a Secret, a ConfigMap or `envFrom` is not adoptable until it is set as a plain value.

## 0.13.2

### Patch Changes

- [#62](https://github.com/henryj-dev/stardust/pull/62) [`7ee6a6a`](https://github.com/henryj-dev/stardust/commit/7ee6a6a9053ce1b7aaf0cfe5e4ebd18c442e738d) Thanks [@mack-erel](https://github.com/mack-erel)! - Databases: every pod the `db-statefulset` plugin renders (the instance, grant Jobs, the backup CronJob and restore checks) now passes Pod Security Admission `restricted`: non-root as uid 70, `RuntimeDefault` seccomp, no privilege escalation, all capabilities dropped. Backups and restore checks no longer install packages at run time; each step runs in an official image pinned by digest (postgres, SOPS, the AWS CLI), sharing an `emptyDir`. Dumps are now encrypted with SOPS to the same age recipient and stored as `dumpall-<stamp>.sql.gz.sops.json` beside their `.fingerprint`; older `.sql.gz.age` dumps are still pruned by retention but are not read by the restore check, so run a backup before the next check.

## 0.13.1

### Patch Changes

- [#60](https://github.com/henryj-dev/stardust/pull/60) [`7efadf5`](https://github.com/henryj-dev/stardust/commit/7efadf5c2f2a46962e477da0feca346b53ddfec1) Thanks [@mack-erel](https://github.com/mack-erel)! - Plugin WebSockets now work through the dashboard: the web server hands upgrades under `/api/v1/plugins/<plugin>/` to the API unchanged, so node agents can connect where the dashboard is the only way in. Other upgrades are refused at the dashboard.

## 0.13.0

### Minor Changes

- [#38](https://github.com/henryj-dev/stardust/pull/38) [`29022f4`](https://github.com/henryj-dev/stardust/commit/29022f428ec84c4084788ea838ed1badca3afe57) Thanks [@mack-erel](https://github.com/mack-erel)! - Account management in the dashboard: an administrators' Users page (add people, make or unmake administrators, disable, end all sessions, and hand out one-time invitation and reset links instead of email), an Account page to change one's password and end sessions, and a detail page for each audit event.

- [#35](https://github.com/henryj-dev/stardust/pull/35) [`2584680`](https://github.com/henryj-dev/stardust/commit/2584680388440a67cc07d0ce4a5742967cbac2a3) Thanks [@mack-erel](https://github.com/mack-erel)! - New `store-s3` plugin (S3, R2 or MinIO): the worker keeps each finished build's log, with credentials it recognises masked, and the run page shows that copy after the cluster has cleaned the build up.

- [#48](https://github.com/henryj-dev/stardust/pull/48) [`6e76bda`](https://github.com/henryj-dev/stardust/commit/6e76bda5afd53fa82b22d9ed11e3865c6f8ece33) Thanks [@mack-erel](https://github.com/mack-erel)! - Pipeline W: components released as Cloudflare Workers with the new `target-cf-workers` plugin (D1 migrations, `secret bulk`, deploy; the token never meets the repository's own build), through a new `deployTargets` port the worker hands W jobs to.

- [#52](https://github.com/henryj-dev/stardust/pull/52) [`aad74cb`](https://github.com/henryj-dev/stardust/commit/aad74cb9ed02beac390da8c69560eebba089f6ae) Thanks [@mack-erel](https://github.com/mack-erel)! - New `cloud-audit` and `audit-cloudflare` plugins: stardust reads a Cloudflare account's audit log every 30 minutes and shows on a Cloud audit page what its rules find (automation tokens out of scope, changes to protected areas, unknown tokens, failed attempts). The rules are in core and work on any `auditLogs` source.

- [#49](https://github.com/henryj-dev/stardust/pull/49) [`d63fd35`](https://github.com/henryj-dev/stardust/commit/d63fd355d297d679057f7f65b7bfd68c4963b818) Thanks [@mack-erel](https://github.com/mack-erel)! - New `compute` port and `cloud-vultr` plugin for Vultr instances, meant to run behind the Vultr broker now in `broker/vultr`: the broker holds the account key, lets through only stardust's calls, and deletes only with a signed, single-use ticket for one instance.

- [#53](https://github.com/henryj-dev/stardust/pull/53) [`7509122`](https://github.com/henryj-dev/stardust/commit/7509122b11af51b56cfc70c597b67ca7cc6c79fb) Thanks [@mack-erel](https://github.com/mack-erel)! - New `costs` plugin and port: the home page shows administrators what each billed source costs a month; a `cloud-vultr` account prices its instances at their plans.

- [#47](https://github.com/henryj-dev/stardust/pull/47) [`633d1df`](https://github.com/henryj-dev/stardust/commit/633d1dfc262e85c0c0bf5251bdf5adfd2737e761) Thanks [@mack-erel](https://github.com/mack-erel)! - Databases: backups now store a fingerprint of each source with its dump, and "Check that it restores" restores the newest dump into a throwaway server and compares. Instances can be deleted when `databases.allowDelete` is on, after their grants are revoked and a restore check passed. Plugin routes can require a recent sign-in with `fresh: true`.

- [#46](https://github.com/henryj-dev/stardust/pull/46) [`e27881f`](https://github.com/henryj-dev/stardust/commit/e27881f09635f0c09554c81f3455e4415da9f721) Thanks [@mack-erel](https://github.com/mack-erel)! - New `databases` plugin: a Databases page to create PostgreSQL instances, adopt running ones, and give an application its own role and database, with its connection settings written to its env; and encrypted backups of every instance. All of it as commits to the deploy repository, with passwords generated and sealed on the server. Plugins can set secret env values through the new `projectEnv` port.

- [#45](https://github.com/henryj-dev/stardust/pull/45) [`f2917a1`](https://github.com/henryj-dev/stardust/commit/f2917a1f5c6b5aa4b7a2ada6369368816ad2438e) Thanks [@mack-erel](https://github.com/mack-erel)! - New `databases` port and `db-statefulset` plugin: finds PostgreSQL StatefulSets in the namespaces it is given and renders instances, application grants and encrypted backup CronJobs for the coming `databases` feature. The chart's `databases.namespaces` gives the server read-only access there.

- [#41](https://github.com/henryj-dev/stardust/pull/41) [`6431649`](https://github.com/henryj-dev/stardust/commit/6431649bbd7c7b1bc9be1663f79aefc7cdf9b4be) Thanks [@mack-erel](https://github.com/mack-erel)! - DNS providers as plugins: `dns-cloudflare` and `dns-parallax` (split-horizon views, each write applied and waited for), behind one `dns` port that both pass the same contract suite.

- [#42](https://github.com/henryj-dev/stardust/pull/42) [`8fffa3d`](https://github.com/henryj-dev/stardust/commit/8fffa3dbc483106fedafa53ceb071c6edebcc7f1) Thanks [@mack-erel](https://github.com/mack-erel)! - New `domains` plugin: a Domains page listing the zones every DNS provider holds, with registrar and expiry from RDAP, and each zone's records, which administrators can set and remove.

- [#36](https://github.com/henryj-dev/stardust/pull/36) [`3d3b2b1`](https://github.com/henryj-dev/stardust/commit/3d3b2b1b71bb58598fc0b37081ccd24a27a89fc8) Thanks [@mack-erel](https://github.com/mack-erel)! - Env editing refuses a plain value whose name looks like a secret's unless it is declared public (`plainOnPurpose`), a component's page shows whether its env change has landed (applied, rolled out), the rendered ConfigMap's header names the configured env root, and stamping a pod template no longer reformats the rest of the manifest.

- [#54](https://github.com/henryj-dev/stardust/pull/54) [`6d901f4`](https://github.com/henryj-dev/stardust/commit/6d901f47a9444d146f0bd54e608029de9e09bfa5) Thanks [@mack-erel](https://github.com/mack-erel)! - External projects (`trust: external` in a project's metadata): built without a clone token or project secret, only mirrored unless listed in `jobs.upstreamBuilds`, and run only at their `pin`. New pipeline M mirrors a published image pinned by digest into your registry, checking the copy's digest. Pipeline W components may now have `buildEnv`.

- [#56](https://github.com/henryj-dev/stardust/pull/56) [`33ac0ae`](https://github.com/henryj-dev/stardust/commit/33ac0ae6f2206d851c53dab781944f492a4d082e) Thanks [@mack-erel](https://github.com/mack-erel)! - Private repositories through a GitHub App (`source-github.appId` and `privateKey`): each build gets a read-only token for its repository alone, in a Secret owned by the build Job and seen by the clone step only; a private repository the App is not installed on is refused. The chart lets the worker create Secrets and patch Jobs in the builds namespace.

- [#51](https://github.com/henryj-dev/stardust/pull/51) [`40be22b`](https://github.com/henryj-dev/stardust/commit/40be22b6e96543d9e920216cb47e62015faaf49d) Thanks [@mack-erel](https://github.com/mack-erel)! - Instances: an `instanceHooks` port lets other systems enrol and release instances. A hook may add to an instance's cloud-init (joined as multipart, never stored, cleared once the instance runs) or refuse a create, and is told when an instance runs and around its deletion, which it may refuse.

- [#50](https://github.com/henryj-dev/stardust/pull/50) [`d39cea0`](https://github.com/henryj-dev/stardust/commit/d39cea07a8b7be2ced37bbf39d635500416a55c3) Thanks [@mack-erel](https://github.com/mack-erel)! - New `instances` plugin: an Instances page to create cloud instances (a resumable saga with DNS records, a reverse name that resolves back, and user data cleared), resize them, and delete them with a fresh, single-use approval; protected hosts are never deleted. Plugins can declare ports they `use` when configured.

- [#43](https://github.com/henryj-dev/stardust/pull/43) [`bcd655c`](https://github.com/henryj-dev/stardust/commit/bcd655c7a1a785630190015c40b181b0752be712) Thanks [@mack-erel](https://github.com/mack-erel)! - New `nodes` plugin: hosts running the node agent connect over a WebSocket with a per-host token; a Nodes page shows each host's state and latest metrics, and administrators issue and revoke tokens. Plugins can now declare WebSocket routes for peers with their own credential.

- [#40](https://github.com/henryj-dev/stardust/pull/40) [`288a291`](https://github.com/henryj-dev/stardust/commit/288a291b5c43b003ff120520d92af903df84c33b) Thanks [@mack-erel](https://github.com/mack-erel)! - Single sign-on sessions follow the provider's: signing out of stardust also signs out at the provider, and an OpenID Connect back-channel logout ends the matching stardust sessions. `identity-oidc` can require `amr` values (`mfa.requireAmr`), and a single sign-on session confirms it is you by signing in again at the provider.

- [#29](https://github.com/henryj-dev/stardust/pull/29) [`09493e9`](https://github.com/henryj-dev/stardust/commit/09493e9faff4888afade75f2095f928a64c94c29) Thanks [@mack-erel](https://github.com/mack-erel)! - Plugins can add API routes under `/api/v1/plugins/<plugin>/` (each behind one of the plugin's own permissions, and audited when it changes something), their own tables, schedules that run on one worker at a time, and capabilities that `GET /api/v1/capabilities` lists for the dashboard.

- [#28](https://github.com/henryj-dev/stardust/pull/28) [`cacdaa1`](https://github.com/henryj-dev/stardust/commit/cacdaa1c96865c8e6972c7fa543951bfc54f4972) Thanks [@mack-erel](https://github.com/mack-erel)! - Plugins now provide ports (the source host, the deploy repository, the cipher, the builder, sign-in) that the server and the worker assemble from configuration, instead of each entry point wiring plugins by hand. Both processes now validate every plugin section at start-up, so a typo in any section stops either one.

- [#34](https://github.com/henryj-dev/stardust/pull/34) [`fa467b6`](https://github.com/henryj-dev/stardust/commit/fa467b6bc31b2f9c2c47410dd4b0b9e1325e7667) Thanks [@mack-erel](https://github.com/mack-erel)! - Pod logs on a component's page: the new `logs-kube` plugin follows live pods through the Kubernetes API, and `logs-loki` reads what Loki kept after a pod is gone. Only a component's own pods can be read. Plugin routes can now stream plain text.

- [#37](https://github.com/henryj-dev/stardust/pull/37) [`39e1011`](https://github.com/henryj-dev/stardust/commit/39e101141dd335140aae2a93b749e698096dd0d4) Thanks [@mack-erel](https://github.com/mack-erel)! - A run is now refused before building when a component's deploy directory has no manifest using its image. Administrators can scaffold starter manifests into an empty deploy directory, change components one at a time, and delete a project, optionally withdrawing its manifests from the deploy repository in one commit.

- [#31](https://github.com/henryj-dev/stardust/pull/31) [`0660f3c`](https://github.com/henryj-dev/stardust/commit/0660f3ca53e2bf4786c2315dd14b29832584e4d2) Thanks [@mack-erel](https://github.com/mack-erel)! - **`region` is now required in `stardust.yaml`** (under Helm, `config.region`): the region this installation serves, a lower-case name with no default. Plugins see it, their migrations say whether each one is global or regional, and access decisions, accounts, roles, projects and the audit log go through a global database handle (the same database until stardust runs in several regions).

- [#57](https://github.com/henryj-dev/stardust/pull/57) [`405e1bd`](https://github.com/henryj-dev/stardust/commit/405e1bd18563321e217f6eda849e29f6a6de69d9) Thanks [@mack-erel](https://github.com/mack-erel)! - Several regions: `database.globalUrl` names the primary every region shares (both databases get the whole schema; regional databases keep replicated copies of the global tables), and a project belongs to the region it was made in: other regions refuse to change it, answering 409 with the owner.

- [#32](https://github.com/henryj-dev/stardust/pull/32) [`22e574a`](https://github.com/henryj-dev/stardust/commit/22e574abeb4ff3e731ff19a59c576d749fc477fc) Thanks [@mack-erel](https://github.com/mack-erel)! - Components can be rolled back to an earlier delivery (the previous one, or one you choose) from their new page or the API, jobs that have not finished can be cancelled (a running build is stopped), and `jobs.maxRunning` caps how many jobs run at once across workers.

- [#33](https://github.com/henryj-dev/stardust/pull/33) [`4bae9de`](https://github.com/henryj-dev/stardust/commit/4bae9de84a31d34251a0b6fbca5acf611359d6b9) Thanks [@mack-erel](https://github.com/mack-erel)! - New `runtime` plugin: a component's page shows its workloads, pods and recent events, and maintainers can restart it and change replicas or container resources, each as a commit to the deploy repository. The chart's `runtime.namespaces` gives the server a read-only Role in each listed namespace. Plugin permissions can now be granted per project, to its viewers or its maintainers.

- [#30](https://github.com/henryj-dev/stardust/pull/30) [`0724ce3`](https://github.com/henryj-dev/stardust/commit/0724ce3ebb2989921e6ffcc9e397bb9f10b67f0b) Thanks [@mack-erel](https://github.com/mack-erel)! - Core gains sagas (multi-step work that resumes after a crash and undoes finished steps when one fails), single-use approval tickets, protected targets and a reveal rate rule, kept in the new `saga_runs`, `guard_used` and `guard_events` tables, and contract test suites that a port's fake and its real implementations both run.

- [#39](https://github.com/henryj-dev/stardust/pull/39) [`5098160`](https://github.com/henryj-dev/stardust/commit/5098160717899459707b39093a33df3ffcd1e29d) Thanks [@mack-erel](https://github.com/mack-erel)! - Two-step sign-in for local accounts: TOTP with any authenticator app and one-time recovery codes, set up on the Account page, with `auth.local.totp` off, optional (default) or required and an optional `auth.local.totpKey` that seals the secrets. Deleting a project, issuing a sign-in link and resetting someone's TOTP now need a recent sign-in (`auth.reauthMinutes`), confirmed with the password or a code. `auth.local.enabled: false` turns password sign-in off.

- [#58](https://github.com/henryj-dev/stardust/pull/58) [`e3e60cc`](https://github.com/henryj-dev/stardust/commit/e3e60cc4f24ffb7c352f6c8e0663e83e6fe89c10) Thanks [@mack-erel](https://github.com/mack-erel)! - One dashboard over several regions: with `web.regions` (STARDUST_REGIONS), the web sends each project's work to the region that owns it and reads shared things from whichever region answers; a region that is down fails only what belongs to it. The SDK's `createClient` takes `regions` for the same.

- [#55](https://github.com/henryj-dev/stardust/pull/55) [`35affc8`](https://github.com/henryj-dev/stardust/commit/35affc883484e4ae8fdeddd44a83f0942f76edd2) Thanks [@mack-erel](https://github.com/mack-erel)! - New `upstream-images` plugin: a daily check of whether each mirrored component's pinned Docker Hub image has a newer release, listed on an Upstream images page. The `projects` port can now list projects and tells plugins each component's pipeline and mirrored image.

### Patch Changes

- [#44](https://github.com/henryj-dev/stardust/pull/44) [`409f780`](https://github.com/henryj-dev/stardust/commit/409f78055e0466d795755d43404ebc924a3d5a53) Thanks [@mack-erel](https://github.com/mack-erel)! - The node agent's source is now in `agent/`. It no longer has a built-in server address: it exits quietly until `/etc/node-agent/url` is set, and accepts `http://` as well as `https://`.

## 0.12.0

### Minor Changes

- [#26](https://github.com/henryj-dev/stardust/pull/26) [`1b1b951`](https://github.com/henryj-dev/stardust/commit/1b1b951558b69a27d9d85e677778ae6b68025389) Thanks [@mack-erel](https://github.com/mack-erel)! - The env layers' directory in the deploy repository can be set with `gitops-git`'s `envRoot` (default `deploy/env`, as before). Every layer moves with it, the global one included, so several installations can share one deploy repository without reading each other's global env, and each one's age identity only needs to open the files under its own root.

## 0.11.0

### Minor Changes

- [#23](https://github.com/henryj-dev/stardust/pull/23) [`8887173`](https://github.com/henryj-dev/stardust/commit/888717308cff8afb6831e7e31e711afccf5a85ec) Thanks [@mack-erel](https://github.com/mack-erel)! - An audit log records who did what: sign-ins and failed sign-ins, sign-outs, users, password resets, API tokens, projects, members and runs. Administrators read it at **Audit log** (`GET /api/v1/audit`), a project's maintainers read their project's events; events name things and never hold a password, token or secret. `audit.retentionDays` (365 by default) sets how long events are kept.

- [#24](https://github.com/henryj-dev/stardust/pull/24) [`865be8d`](https://github.com/henryj-dev/stardust/commit/865be8de616b7aa20de0871c3f5f3f8393bf27e3) Thanks [@mack-erel](https://github.com/mack-erel)! - Maintainers edit a project's env and secrets in the dashboard (**Environment** on the project page, `GET`/`PATCH /api/v1/projects/<id>/env`). Each change is one compare-and-swap commit to the deploy repository: the env layer, the rendered ConfigMap and SOPS-encrypted Secret of every component that reads it, and a pod-template stamp so the workloads roll out; a layer changed since it was read is refused. Secret values are write-only. It is off until the server is given `gitops-git`, `secrets-sops-age` and the age identity (`envEditing.ageKeySecret` in the chart); the server image now has git and sops.

## 0.10.0

### Minor Changes

- [#21](https://github.com/henryj-dev/stardust/pull/21) [`e4561f5`](https://github.com/henryj-dev/stardust/commit/e4561f5dcf12690f33c938ab17cf0f3f563b7cc3) Thanks [@mack-erel](https://github.com/mack-erel)! - Each run has its own page in the dashboard, linked from the project's run list and the home page: the run's ref, commit, who pulled it and when, and per job its status, attempt, start, finish and duration, why it failed, the image digest, the build job and the deploy commit. It updates live.

  The page shows each job's build log as the build prints it, read from the build pod while the cluster keeps it (an hour after the build by default); after that the page says the log is gone, and a failed build still shows the last lines the worker kept. The API has `GET /api/v1/projects/:id/runs/:runId` and `GET /api/v1/projects/:id/runs/:runId/jobs/:job/log` (`?follow=true` to stream), and the SDK `run()` and `buildLog()`. Jobs in run views now carry `startedAt` and `finishedAt`.

  With `builds.enabled`, the chart now gives the server its own service account with a token and a read-only Role in the builds namespace (get and list pods, get pod logs) to read build logs. Set `builds.logs: false` to keep the server without a token; runs then show no log.

## 0.9.0

### Minor Changes

- [#19](https://github.com/henryj-dev/stardust/pull/19) [`b52ce9a`](https://github.com/henryj-dev/stardust/commit/b52ce9a01bfb91dcdf28d224f4eb5ed5db264545) Thanks [@mack-erel](https://github.com/mack-erel)! - Administrators can create and edit projects in the dashboard: repository, and per component the pipeline, build context, Dockerfile or Node port and build environment, and deploy directory. Saving keeps the project's pipeline definition and metadata as they are. The SDK has `putProject()`.

## 0.8.1

### Patch Changes

- [#17](https://github.com/henryj-dev/stardust/pull/17) [`e3cc849`](https://github.com/henryj-dev/stardust/commit/e3cc8497a995e6c2799fda7ff063e660b75a98c9) Thanks [@mack-erel](https://github.com/mack-erel)! - The dashboard answers `GET /healthz` (and `HEAD`) with `200 ok`, without a session or a call to the API. Since 0.8.0 a signed-out `/` redirects to sign in, which proxies and load balancers checking for a 2xx read as down; point their health checks at `/healthz`. The chart's web probes use it too.

## 0.8.0

### Minor Changes

- [#15](https://github.com/henryj-dev/stardust/pull/15) [`0c2db28`](https://github.com/henryj-dev/stardust/commit/0c2db28d8f04f4f554e4a1b4f7383670ee90375f) Thanks [@mack-erel](https://github.com/mack-erel)! - The dashboard has a home page: signed in, `/` lists the projects you can read with each one's latest run (when, ref, commit, status, who pulled it) and links to the project; signed out, it sends you to sign in and back. Every page has a header with your name and a Sign out button. A session the API no longer accepts is dropped on the next request, so you are asked to sign in again instead of seeing an error. `GET /api/v1/projects` now gives each project a `lastRun` (its newest run without jobs, or `null`), and the SDK has `session()`.

## 0.7.0

### Minor Changes

- [#13](https://github.com/henryj-dev/stardust/pull/13) [`c32037a`](https://github.com/henryj-dev/stardust/commit/c32037abaf6b1f17a3a8d1d1f8449aada0bc9be2) Thanks [@mack-erel](https://github.com/mack-erel)! - Webhooks are removed: a run starts only when someone with write access asks for one ("Pull and deliver", or `POST /api/v1/projects/:id/runs`), so a push or a merge never deploys by itself. `POST /webhooks/github/:project` and `POST /api/v1/projects/:id/plan` are gone, and projects no longer have a `webhookKind`. Upgrading needs no configuration change: a `webhookSecret` left in `plugins.source-github` is accepted, ignored and logged. Resolving a branch also works with Gitea's API now, which answers `branches/<name>` rather than `commits/heads/<name>`.

## 0.6.0

### Minor Changes

- [#11](https://github.com/henryj-dev/stardust/pull/11) [`ea0af5e`](https://github.com/henryj-dev/stardust/commit/ea0af5ea238704b6cf41d35ed5593391e97ad8a2) Thanks [@mack-erel](https://github.com/mack-erel)! - Pipeline `N` builds install with pnpm whatever lockfile the app carries, and run with node. A `pnpm-lock.yaml` is used as it is; an npm or yarn lockfile is turned into one by `pnpm import`, so its pinned versions are kept; a bun lockfile, or none, is resolved fresh from `package.json`; lockfiles of more than one package manager stop the build. pnpm is pinned (12.14.0) unless the app names its own in `packageManager`. Apps that carried only a bun lockfile could not be built before.

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
