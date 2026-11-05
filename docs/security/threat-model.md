# Threat model

What stardust protects, from whom, and where each protection lives. Keep it
current: a change that moves a trust boundary updates this page in the same
pull request.

## What is worth attacking

| Asset                                              | Why it matters                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Source host token (`source-github.token`)          | Reads the repositories it can see.                                                                                                           |
| Deploy repository credentials (`gitops-git.token`) | Whatever is committed there is deployed by the GitOps controller. **This is the most valuable credential: write access here is deployment.** |
| Registry push credentials (builds namespace)       | Pushing an image under a deployed tag replaces what runs.                                                                                    |
| age identity (`secrets-sops-age.ageKeyFile`)       | Decrypts every secret in the deploy repository.                                                                                              |
| Sessions, API tokens, passwords                    | Act as a user. Stored as SHA-256 (tokens) and scrypt (passwords).                                                                            |
| The PostgreSQL database                            | Holds the above as hashes, plus projects, runs and pending OpenID logins. Holds no plain credential.                                         |

## Who

- **Anyone on the internet** who can reach the dashboard and the API.
- **A contributor to a delivered repository**, who controls commit contents,
  branch names, file paths, Dockerfiles and commit messages. They cannot start
  a build: stardust takes no webhooks, and a run starts only when a user with
  write access asks for one.
- **A signed-in user** with fewer rights than they want (viewer, or no role).
- **The OpenID provider's users**, who may choose their own username or email.
- Out of scope: someone with cluster-admin, write access to the deploy
  repository, or the database's superuser. They already have what stardust
  protects.

## Boundaries and the controls on each

### No webhooks

- stardust exposes no webhook route (`/webhooks/…` answers 404), so nothing
  outside an authenticated API call can start a build. Removed in favour of
  asking for runs; there is no shared signing secret left to leak.

### Runs → build

- `POST /api/v1/projects/<id>/runs` needs write access to the project. The
  run records who asked.
- The target is checked before the source host is asked: one of a branch, a
  tag or a full commit hash, with ref names limited to characters git and a
  URL path accept as they are.
- A commit given by hash must be in the default branch's history. GitHub
  serves commits from anywhere in a repository's fork network under the
  repository's name, so a hash alone could otherwise build someone's fork.
- A run deploys what it builds. Delivering a repository you do not control is
  a decision to run its code: pin a tag you have read. A merge upstream does
  not deploy by itself.

### Repository contents → build

- A build is a Kubernetes Job in its own namespace. The clone runs in an init
  container; its token reaches git through `GIT_CONFIG_COUNT` environment
  variables, not a URL, argument or file.
- Repository-controlled values (revision, paths, Dockerfile name) reach the
  build containers **only as environment variables**; the scripts are
  constants, so a value cannot become shell code (`plugins/builder-buildkit/src/job.ts`).
- BuildKit runs rootless. The resulting digest is read only from
  `containerimage.digest` in BuildKit's metadata.
- The registry push credential is mounted in the BuildKit container, not in
  the build steps: `RUN` steps execute in BuildKit's own sandbox and do not
  see it. But **whatever a built commit produces is pushed under the
  project's tag and then deployed**, so who can get a commit built is who can
  deploy. Builds start only when a user with write access asks for one.

### Worker → deploy repository

- **A pull request is built, never deployed**: its head is unreviewed code.
  No new pull-request runs are created since webhooks were removed; the guard
  stays for runs recorded before that.
- Image bumps are commits made with compare-and-swap on the expected head
  (`--force-with-lease`), so a concurrent change is never overwritten.
- Env changes (not yet exposed through the API) are meant to reach pods by
  stamping the pod template in Git, not by restarting on the cluster, which
  the controller would revert. Editing secrets through the API will get its
  own review before it ships.

### Users → API

- Every `/api/v1` route except sign-in requires a session or API token. A test
  reads the router's route table and checks that each route refuses a missing
  session (401) and a user without a role (403, or 404 for a project), so a
  new route without a check fails CI (`packages/server/src/app.dbtest.ts`).
- Projects a user cannot read answer 404, so their names do not leak.
- Passwords: scrypt, 12 to 1024 characters. Ten failures in 15 minutes lock
  the username; each attempt is recorded before the password is checked, so
  parallel guesses get no more tries than sequential ones. API bodies are
  limited to 64 KiB. An unknown username costs the same scrypt work as a wrong
  password.
- Password recovery is a command inside the server container: access to the
  deployment is the authority, so there is no recovery endpoint to attack.

### OpenID provider → server

- Code flow with PKCE (S256), nonce and a one-time state that expires in ten
  minutes. The dashboard keeps the state in its own cookie and the server
  requires it to match, which stops login CSRF.
- The ID token's signature is checked against the provider's published keys,
  in addition to issuer, audience, expiry and nonce.
- People are matched by issuer and subject only. A new identity whose username
  belongs to another account is refused, never linked to it.

### Browser → dashboard

- The session cookie is HttpOnly, SameSite=Strict, and Secure over https.
- The dashboard talks to the server only through the SDK (enforced by
  dependency-cruiser). Form actions rely on SvelteKit's origin check.
- Sign-in errors are carried in a short-lived cookie, not the URL.

### Releases → people who deploy them

- Images and the chart are built on GitHub-hosted runners, signed keylessly by
  `release.yml` on `main`, and verified in CI with a wrong-identity control.
  Actions are pinned by commit SHA. See [releasing.md](../releasing.md).

## Known gaps

Found in the pre-publication review (2026-10-27) and not fixed yet:

- **Anyone can lock an account** by failing to sign in as it ten times in 15
  minutes, including the bootstrap administrator. The lockout is per username,
  not per username and address.
- **`autoCreate` without `allowedGroups`** lets anyone the provider accepts
  create an account, and claim a username before its owner signs in. Roles are
  granted by username. Use `allowedGroups` with `autoCreate`.
- **The builds namespace must allow privileged-adjacent pods** (BuildKit needs
  unconfined seccomp and AppArmor), and the worker may create Jobs there. A
  compromised worker can run such pods in that namespace. An admission policy
  pinning the build image and security context would close this.

- **Builds share one push credential per builds namespace.** A malicious commit
  that gets built can push other images that credential can reach. Use one
  registry repository per project, and a credential limited to it.
- **No audit log yet** of who changed what in the API.
- **Sessions are not bound to a client** (IP or device). A stolen session
  cookie works until it expires (12 hours) or the user signs out.
- **OpenID sign-out does not end the provider's session**, and the provider
  revoking a user does not end that user's stardust sessions before they
  expire.
- **GitHub App authentication covers the deploy repository only**
  (`gitops-git.githubApp`: hour-long installation tokens narrowed to that
  repository and `contents: write`). The source plugin still takes a
  long-lived token when it needs one; public repositories need none.
