/**
 * Plugin WebSockets, attached to the HTTP server's upgrade event. A socket
 * route takes no stardust session: the plugin checks the peer's own
 * credential from the upgrade request's headers before the upgrade, and an
 * unknown path or a refused credential is answered without upgrading.
 * Frames are text, at most 64 KiB.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Feature, Logger, SocketRoute } from "@stardust/core";
import { WebSocketServer } from "ws";

const MAX_FRAME = 64 * 1024;

function refuse(socket: Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Routes by full path: `/api/v1/plugins/<plugin><path>`. */
export function socketRoutes(features: readonly Feature[]): Map<string, { plugin: string; route: SocketRoute }> {
  const routes = new Map<string, { plugin: string; route: SocketRoute }>();
  for (const f of features) {
    for (const route of f.sockets) routes.set(`/api/v1/plugins/${f.plugin}${route.path}`, { plugin: f.plugin, route });
  }
  return routes;
}

/** Returns a function that closes every open plugin socket, for shutting down. */
export function attachSockets(server: Server, features: readonly Feature[], log: Logger): () => void {
  const routes = socketRoutes(features);
  if (routes.size === 0) return () => {};
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://stardust").pathname;
    const found = routes.get(path);
    if (!found) return refuse(socket, 404, "Not Found");
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    void found.route.authenticate(headers).then(
      (principal) => {
        if (!principal) return refuse(socket, 401, "Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => {
          const connection = {
            send: (text: string) => ws.readyState === ws.OPEN && ws.send(text),
            close: (code?: number, reason?: string) => ws.close(code ?? 1000, reason),
          };
          const ready = Promise.resolve(found.route.open(principal, connection)).catch((err: Error) => {
            log.error("a plugin socket failed to open", { plugin: found.plugin, error: err.message });
            ws.close(1011, "internal error");
            return null;
          });
          // One frame at a time, in the order they came: a session sees its peer's frames in sequence.
          let queue: Promise<unknown> = ready;
          ws.on("message", (data, isBinary) => {
            if (isBinary) return ws.close(1003, "text frames only");
            const text = data.toString("utf8");
            queue = queue
              .then(async () => (await ready)?.message(text))
              .catch((err: Error) => {
                log.warn("a plugin socket message failed", { plugin: found.plugin, error: err.message });
              });
          });
          ws.on("close", () => {
            queue = queue.then(async () => (await ready)?.close()).catch(() => {});
          });
        });
      },
      (err: Error) => {
        log.error("a plugin socket's authentication failed", { plugin: found.plugin, error: err.message });
        refuse(socket, 500, "Internal Server Error");
      },
    );
  });
  return () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
