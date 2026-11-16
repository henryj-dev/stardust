# syntax=docker/dockerfile:1
#
# The Vultr API key broker. Build from the repository root:
#
#   docker build -f broker/vultr/Dockerfile .
#
# The image holds only this package and its three dependencies, not the rest of the
# workspace: the broker is trusted because it is small, and so is its image. It imports
# nothing from other workspace packages; an import from outside broker/vultr would pass
# tests locally and fail to start here. Before adding one, ask whether it is needed at all.
#
# broker/vultr/Dockerfile.dockerignore replaces the root .dockerignore for this build, so
# the test stage sees the test files.
#
# Like the root Dockerfile, the image runs TypeScript directly. Node only strips types
# outside node_modules, so the workspace layout is kept.

ARG NODE_IMAGE=node:26.12.1-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec

FROM ${NODE_IMAGE} AS base
ENV CI=true
RUN npm install --global pnpm@12.14.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY broker/vultr/package.json ./broker/vultr/package.json

# The policy tests are the substance of this service: run them on the same files that go
# into the image. CI builds this stage first with `--target test`.
FROM base AS test
RUN pnpm install --frozen-lockfile --filter @stardust/vultr-broker
COPY broker/vultr ./broker/vultr
RUN node --test "broker/vultr/src/**/*.test.ts"

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @stardust/vultr-broker

FROM ${NODE_IMAGE} AS runtime
ARG BUILD_SHA=unknown
ENV NODE_ENV=production \
    BUILD_SHA=${BUILD_SHA}
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/broker/vultr/node_modules ./broker/vultr/node_modules
COPY --chown=node:node broker/vultr/package.json ./broker/vultr/package.json
# All of src goes in, tests included: they are a few files, and copying files one by one
# makes it easy to leave a new one out silently.
COPY --chown=node:node broker/vultr/src ./broker/vultr/src
USER node
EXPOSE 8080
CMD ["node", "broker/vultr/src/main.ts"]
