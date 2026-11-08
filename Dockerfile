# syntax=docker/dockerfile:1
#
# One Dockerfile, three targets: server, worker, web.
#
# The server and worker run TypeScript sources directly. Node only strips types
# outside node_modules, so the image keeps the workspace layout: workspace
# packages stay at packages/* and are linked into node_modules by pnpm.

ARG NODE_IMAGE=node:26.12.1-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec

FROM ${NODE_IMAGE} AS base
ENV CI=true
RUN npm install --global pnpm@12.14.0 && npm cache clean --force
WORKDIR /app

FROM base AS prod-deps
COPY . .
RUN pnpm install --frozen-lockfile --prod

FROM base AS web-build
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @stardust/web run build

# Editing env writes to the deploy repository (git) and encrypts with SOPS.
# sops is a pinned release, checked against its published checksum.
FROM ${NODE_IMAGE} AS server
ARG VERSION=dev
ARG TARGETARCH
ARG SOPS_VERSION=3.13.3
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates curl \
 && case "${TARGETARCH:-amd64}" in \
      amd64) sum=e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b ;; \
      arm64) sum=53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77 ;; \
      *) echo "no sops checksum for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/sops "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${TARGETARCH:-amd64}" \
 && echo "${sum}  /usr/local/bin/sops" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/sops \
 && apt-get purge --yes curl && apt-get autoremove --yes \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    STARDUST_VERSION=${VERSION} \
    STARDUST_CONFIG=/etc/stardust/stardust.yaml
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "packages/server/src/main.ts"]

# The worker writes to the deploy repository with the git command line.
FROM ${NODE_IMAGE} AS worker
ARG VERSION=dev
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    STARDUST_VERSION=${VERSION} \
    STARDUST_CONFIG=/etc/stardust/stardust.yaml
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app /app
USER node
CMD ["node", "packages/worker/src/main.ts"]

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=web-build --chown=node:node /app/packages/web/build ./build
COPY --from=web-build --chown=node:node /app/packages/web/package.json ./package.json
COPY --from=web-build --chown=node:node /app/packages/web/server.ts ./server.ts
USER node
EXPOSE 3000
CMD ["node", "server.ts"]
