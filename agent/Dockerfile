# Build artifact for the node agent.
#
# This image is never run as a service. An init container copies the binaries
# into a shared volume and exits; the server then serves them to nodes behind
# token authentication, and each node verifies the digest before atomically
# replacing its binary.
#
# The agent has its own image, separate from the server image, so that a
# one-line agent change does not force a rollout (and restart) of the server.
#
# Multi-arch: the image is built for a single platform (amd64), and inside it
# Go cross-compiles for three GOARCH values. The image's own platform does not
# matter, because all it ever does is run `cp` in the init container. arm64 and
# arm builds are included for ARM hosts such as a Raspberry Pi. File names carry
# an arch suffix and the server picks one with `?arch=`. `node-agent` (no
# suffix) is a copy of the amd64 build, kept for compatibility with consumers
# that expect the unsuffixed name.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
ARG VERSION=dev
# Build flags are pinned. If they drift, the result is a binary that builds but
# does not start on the target host.
#  - CGO_ENABLED=0: otherwise the net packages pull in libc and the binary is
#    dynamically linked.
#  - GOAMD64=v1: require no CPU features beyond baseline x86-64, so the agent
#    still runs after a VM is moved to an older CPU.
#  - GOARM=7: for armv7 (32-bit Raspberry Pi OS); Pi 2 and later are v7.
#    Hard-float is the default.
#  - -trimpath: keep build paths out of the binary (reproducibility).
RUN set -eu; \
    LDFLAGS="-s -w -X main.version=${VERSION}"; \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 \
      go build -trimpath -ldflags "$LDFLAGS" -o /out/node-agent-amd64 .; \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
      go build -trimpath -ldflags "$LDFLAGS" -o /out/node-agent-arm64 .; \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 \
      go build -trimpath -ldflags "$LDFLAGS" -o /out/node-agent-arm .; \
    cp /out/node-agent-amd64 /out/node-agent

# Verify static linking during the build; finding out on a node is too late.
# readelf is an arch-independent ELF parser, so an amd64 builder can check the
# arm64 and arm binaries too.
RUN apk add --no-cache binutils >/dev/null; \
    for b in /out/node-agent-amd64 /out/node-agent-arm64 /out/node-agent-arm; do \
      test "$(readelf -l "$b" | grep -c INTERP)" = "0" || { echo "NOT static (INTERP): $b" >&2; exit 1; }; \
      test "$(readelf -d "$b" 2>/dev/null | grep -c NEEDED)" = "0" || { echo "NOT static (NEEDED): $b" >&2; exit 1; }; \
      echo "static ok: $b"; \
    done

# Alpine rather than scratch: the init container needs a shell to run `cp`.
FROM alpine:3.20
COPY --from=build /out/node-agent-amd64 /usr/local/bin/node-agent-amd64
COPY --from=build /out/node-agent-arm64 /usr/local/bin/node-agent-arm64
COPY --from=build /out/node-agent-arm   /usr/local/bin/node-agent-arm
COPY --from=build /out/node-agent       /usr/local/bin/node-agent
