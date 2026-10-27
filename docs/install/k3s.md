# Installing on a fresh k3s node

This installs a released, signed stardust on a single Linux machine with
nothing on it, and delivers a first push to a running pod. Everything after
the k3s and Flux installs is kept in a Git repository you own, so the
installation can be rebuilt from it.

It was written by doing it: on Rocky Linux 9 with SELinux enforcing, k3s
v1.36.5, Flux v2.9.6 and stardust 0.1.1.

You need a machine with a few CPUs and some disk, `kubectl`, `git`, and a
private Git repository for the cluster's configuration (called the
_config repository_ below). Secrets in it are encrypted with
[SOPS](https://github.com/getsops/sops) and [age](https://github.com/FiloSottile/age).

## 1. k3s

Pin the version, and if the machine has more than one network interface, say
which one the cluster uses: by default k3s picks the one with the default
route, which may be a public one.

```yaml
# /etc/rancher/k3s/config.yaml
node-ip: 10.0.0.13 # the address on the internal network
advertise-address: 10.0.0.13
flannel-iface: eth1 # that network's interface
tls-san: [10.0.0.13]
```

```sh
curl -sfL https://get.k3s.io -o k3s-install.sh
sudo INSTALL_K3S_VERSION=v1.36.5+k3s1 sh k3s-install.sh
```

With SELinux enforcing, the installer adds `k3s-selinux` by itself.

**Host firewall.** If the machine filters with nftables and a default-drop
`forward` chain, pod traffic is dropped until you allow it. With the default
pod range:

```nft
# input: pods and services reach the node; API and ingress from private networks only
ip saddr { 10.42.0.0/16, 10.43.0.0/16 } accept
ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } tcp dport { 80, 443, 6443 } accept
# forward: pod traffic
ip saddr 10.42.0.0/16 accept
ip daddr 10.42.0.0/16 accept
```

Do not reload the nftables service after k3s is running if its reload flushes
the whole ruleset (Rocky's does): that removes k3s's own tables too. Apply
your table alone with `nft -f`.

Check that a pod can resolve names and reach the internet before going on.

## 2. Flux

```sh
curl -sfLO https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml
kubectl apply --server-side -f install.yaml
```

Give Flux a **read-only** deploy key for the config repository and an age key
for decrypting it. Generate both on your machine and put the private halves
only into the cluster:

```sh
age-keygen -o cluster.agekey
kubectl -n flux-system create secret generic sops-age --from-file=age.agekey=cluster.agekey

ssh-keygen -t ed25519 -N '' -f deploy-key
ssh-keyscan -t ed25519 github.com > known_hosts
kubectl -n flux-system create secret generic config-repo-auth \
  --from-file=identity=deploy-key --from-file=identity.pub=deploy-key.pub --from-file=known_hosts
# add deploy-key.pub to the config repository as a read-only deploy key, then delete deploy-key
```

In the config repository, a `.sops.yaml` rule encrypts secrets for that key
(and yours, for recovery):

```yaml
creation_rules:
  - path_regex: \.enc\.yaml$
    encrypted_regex: ^(data|stringData)$
    age: >-
      age1...cluster,
      age1...yours
```

Then point Flux at the repository. Keep `path` inside this cluster's
directory: with `prune: true`, pointing it at another cluster's directory
would run that cluster's apps here.

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata: { name: config, namespace: flux-system }
spec:
  interval: 1m
  url: ssh://git@github.com/<you>/<config-repository>
  ref: { branch: main }
  secretRef: { name: config-repo-auth }
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: { name: apps, namespace: flux-system }
spec:
  interval: 1m
  path: ./clusters/my-cluster/apps
  prune: true
  sourceRef: { kind: GitRepository, name: config }
  decryption: { provider: sops, secretRef: { name: sops-age } }
```

Everything below goes into `clusters/my-cluster/apps/` and reaches the cluster
by being committed.

## 3. PostgreSQL

stardust needs one PostgreSQL database. Any will do; a single StatefulSet on
local storage is enough to start. Generate the password and encrypt it in one
step, so it never sits in a plain file:

```sh
pw="$(openssl rand -base64 32 | tr -d '/+=')"
cat <<EOF | sops --encrypt --filename-override clusters/my-cluster/apps/db.enc.yaml \
  --input-type yaml --output-type yaml /dev/stdin > clusters/my-cluster/apps/db.enc.yaml
apiVersion: v1
kind: Secret
metadata: { name: stardust-db, namespace: stardust }
stringData:
  url: "postgres://stardust:${pw}@postgres.stardust.svc.cluster.local:5432/stardust"
EOF
```

## 4. stardust

Install the chart from the registry, and only once its signature checks out:
Flux verifies the keyless signature against the identity of this project's
release workflow before it uses the chart. The chart pins every image by
digest.

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata: { name: stardust, namespace: stardust }
spec:
  interval: 10m
  url: oci://ghcr.io/henryj-dev/charts/stardust
  ref: { semver: "0.1.x" }
  layerSelector:
    mediaType: application/vnd.cncf.helm.chart.content.v1.tar+gzip
    operation: copy
  verify:
    provider: cosign
    matchOIDCIdentity:
      - issuer: ^https://token\.actions\.githubusercontent\.com$
        subject: ^https://github\.com/henryj-dev/stardust/\.github/workflows/release\.yml@refs/heads/main$
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata: { name: stardust, namespace: stardust }
spec:
  interval: 10m
  chartRef: { kind: OCIRepository, name: stardust }
  values:
    database: { existingSecret: stardust-db, key: url }
    extraEnvFrom:
      - secretRef: { name: stardust-delivery } # tokens, webhook secret, first admin's password
    builds: { enabled: true, namespace: stardust-builds }
    config:
      version: 1
      server:
        port: 8080
        publicUrl: https://stardust.example.com
        bootstrapAdmin: { username: admin, password: { env: ADMIN_PASSWORD } }
      database: { url: { env: DATABASE_URL } }
      plugins:
        source-github: { token: { env: SOURCE_TOKEN }, webhookSecret: { env: WEBHOOK_SECRET } }
        builder-buildkit:
          namespace: stardust-builds
          registry: registry.example.com/my-projects
          cloneSecret: git-clone
          pushSecret: registry-push
        gitops-git:
          url: https://github.com/<you>/<deploy-repository>.git
          branch: main
          username: x-access-token
          token: { env: DEPLOY_TOKEN }
```

The builds namespace runs rootless BuildKit, which needs unconfined seccomp and
AppArmor profiles. Pod Security "baseline" forbids those, so that namespace
must be `privileged`. Keep it for builds only (see the
[threat model](../security/threat-model.md)).

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: stardust-builds
  labels: { pod-security.kubernetes.io/enforce: privileged }
```

`git-clone` (a `token` key) and `registry-push` (a `config.json` key, a Docker
config) are Secrets in that namespace; see
[configuration.md](../configuration.md) for every option.

Check that Flux verified the chart, and that the release is ready:

```sh
kubectl -n stardust get ocirepository stardust   # SourceVerified=True
kubectl -n stardust get helmrelease stardust     # Ready=True
```

## 5. A first delivery

Sign in as `admin`, register a project with `PUT /api/v1/projects/<id>`
(its repository, a pipeline with `on.push.branches`, and a component with the
deploy directory), and add a webhook in the source repository that sends
pushes to `https://<server>/webhooks/github/<id>` with the webhook secret.

Have the GitOps controller apply the deploy repository too, then push a
commit. The run builds the image, commits the digest to the deploy repository,
and the controller rolls it out.

## Things that went wrong while writing this

- **The chart failed to install through Flux in 0.1.0.** Flux appends the
  artifact digest to the chart version (`0.1.0+e6f18c5ec407`), and the chart
  label carried the `+`, which is not valid in a label. Fixed in 0.1.1.
- **Gitea as the source host:** Gitea 28 sends webhooks to private addresses
  only when they are in `[security] ALLOWED_HOST_LIST`, and with
  `EGRESS_MODE = strict` it refused a listed private address too. Use the
  default lax mode with a CIDR for the service range.
