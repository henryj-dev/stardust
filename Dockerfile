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

FROM ${NODE_IMAGE} AS server
ARG VERSION=dev
ENV NODE_ENV=production \
    STARDUST_VERSION=${VERSION} \
    STARDUST_CONFIG=/etc/stardust/stardust.yaml
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "packages/server/src/main.ts"]

FROM server AS worker
CMD ["node", "packages/worker/src/main.ts"]

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=web-build --chown=node:node /app/packages/web/build ./build
COPY --from=web-build --chown=node:node /app/packages/web/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "build"]
