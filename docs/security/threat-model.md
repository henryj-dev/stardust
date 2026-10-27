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
| Webhook secret                                     | Lets a sender start builds.                                                                                                                  |
| Sessions, API tokens, passwords                    | Act as a user. Stored as SHA-256 (tokens) and scrypt (passwords).                                                                            |
| The PostgreSQL database                            | Holds the above as hashes, plus projects, runs and pending OpenID logins. Holds no plain credential.                                         |

## Who

- **Anyone on the internet** who can reach the webhook URL and the dashboard.
- **A contributor to a watched repository**, who controls commit contents,
  branch names, file paths, Dockerfiles and commit messages, and may open
  pull requests from forks.
- **A signed-in user** with fewer rights than they want (viewer, or no role).
- **The OpenID provider's users**, who may choose their own username or email.
- Out of scope: someone with cluster-admin, write access to the deploy
  repository, or the database's superuser. They already have what stardust
  protects.

## Boundaries and the controls on each

### Webhook → server

- HMAC-SHA256 over the raw body with a constant-time compare, before any
  parsing (`plugins/source-github/src/signature.ts`). The body is read up to
  5 MiB and refused beyond (`packages/server/src/body.ts`).
- Policy decides what a delivery may start (`plugins/source-github/src/policy.ts`):
  only configured events and branches, deleted refs ignored, and pull requests
  from forks refused — failing closed when the head repository cannot be read
  (`fork.ts`).
- The changed-path list comes from the source host's compare API, not from the
  payload alone.

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
  deploy. Builds start only for pushes the policy accepts, never for fork pull
  requests.

### Worker → deploy repository

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
- Passwords: scrypt, at least 12 characters. Ten failures in 15 minutes lock
  the username. An unknown username costs the same scrypt work as a wrong
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

- **Builds share one push credential per builds namespace.** A malicious commit
  that gets built can push other images that credential can reach. Use one
  registry repository per project, and a credential limited to it.
- **No audit log yet** of who changed what in the API.
- **Sessions are not bound to a client** (IP or device). A stolen session
  cookie works until it expires (12 hours) or the user signs out.
- **OpenID sign-out does not end the provider's session**, and the provider
  revoking a user does not end that user's stardust sessions before they
  expire.
- **GitHub App authentication is not implemented.** The source token is a
  long-lived personal or bot token.
