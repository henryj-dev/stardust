# agent

The node agent: a small Go program that runs on each host and keeps a
WebSocket open to stardust's `nodes` plugin. It says `hello` once (its
version and host profile), `beat`s every five seconds, and sends `metrics`
(load, memory, disk use, systemd units, network counters) every minute.

## Install

The agent reads two files and exits quietly when either is empty:

- `/etc/node-agent/token`: the host's token, issued on stardust's Nodes page.
- `/etc/node-agent/url`: `<stardust>/api/v1/plugins/nodes` (https becomes wss).

Build with `go build -ldflags "-X main.version=<version>" .` or the
Dockerfile, and run it under systemd with `Restart=always`. It reconnects
with jittered backoff (1 s to 30 s, below the server's 90 s grace) and
resets the backoff after a session that stayed up a minute.

## Protocol

JSON text frames, protocol version 1. `testdata/frames` holds the frames
the agent writes, byte for byte: `go test` checks the agent still writes
them, and the server's parser (`plugins/nodes/src/protocol.ts`) is tested
against the same files. Change both sides together; update the files with
`go test ./... -run TestFrameGolden -update`.
